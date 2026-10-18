const vscode = require("vscode");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");

class GppLanguageServer {
  constructor(outputChannel) {
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.nextRequestId = 1;
    this.pending = new Map();
    this.documentListeners = [];
    this.diagnostics = vscode.languages.createDiagnosticCollection("gpp");
    this.outputChannel = outputChannel;
    this.initialized = false;
    this.disposed = false;
    this.reportedFailure = false;
    this.ready = Promise.resolve(false);
  }

  async start() {
    const configuration = vscode.workspace.getConfiguration("gpp.lsp");
    if (!configuration.get("enabled", true)) {
      this.ready = Promise.resolve(false);
      return;
    }

    const command = resolveGppCommand(configuration.get("command", "~/go/bin/gpp"));
    const args = configuration.get("args", ["lsp"]);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const options = {
      cwd: workspaceFolder?.uri.fsPath,
      stdio: ["pipe", "pipe", "pipe"]
    };

    this.outputChannel.appendLine(`Starting language server: ${command} ${(Array.isArray(args) ? args : ["lsp"]).join(" ")}`);
    this.process = spawn(command, Array.isArray(args) ? args : ["lsp"], options);
    this.process.stdout.on("data", (chunk) => this.read(chunk));
    this.process.stderr.on("data", (chunk) => {
      const output = String(chunk).trim();
      if (output) {
        this.lastServerOutput = output;
        this.outputChannel.appendLine(`[gpp lsp] ${output}`);
      }
    });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("error", (error) => this.fail(error));
    this.process.on("close", (code, signal) => {
      if (!this.disposed && !this.reportedFailure) {
        this.fail(new Error(`Go++ language server exited (${code ?? signal ?? "unknown"})`));
      }
    });

    this.ready = this.initialize(workspaceFolder);
    await this.ready;

    for (const document of vscode.workspace.textDocuments) {
      if (isGoPlusDocument(document)) {
        this.open(document);
      }
    }
  }

  async initialize(workspaceFolder) {
    const folders = (vscode.workspace.workspaceFolders || []).map((folder) => ({
      uri: folder.uri.toString(),
      name: folder.name
    }));
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: workspaceFolder ? workspaceFolder.uri.toString() : null,
      workspaceFolders: folders,
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
          completion: { completionItem: { snippetSupport: true } },
          definition: { linkSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] }
        }
      },
      clientInfo: { name: "Go++ VS Code", version: "0.1.3" }
    });
    if (!result) {
      throw new Error("Go++ language server returned no initialization result");
    }
    this.initialized = true;
    this.notify("initialized", {});
    return true;
  }

  listen(context) {
    this.documentListeners.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (isGoPlusDocument(document)) this.whenReady(() => this.open(document));
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isGoPlusDocument(event.document)) this.whenReady(() => this.change(event));
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isGoPlusDocument(document)) this.whenReady(() => this.save(document));
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (isGoPlusDocument(document)) this.whenReady(() => this.close(document));
      })
    );
    context.subscriptions.push(...this.documentListeners);
  }

  whenReady(action) {
    this.ready.then(() => {
      if (!this.disposed && this.initialized) action();
    }).catch(() => {});
  }

  request(method, params) {
    if (!this.process || this.process.killed || this.disposed) {
      return Promise.reject(new Error("Go++ language server is unavailable"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        reject(new Error("Go++ language server input is unavailable"));
      }
    });
  }

  requestWhenReady(method, params) {
    return this.ready.then((available) => available ? this.request(method, params) : null);
  }

  notify(method, params) {
    if (!this.process || this.process.killed || this.disposed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  write(message) {
    if (!this.process?.stdin?.writable || this.process.killed) return false;
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    try {
      this.process.stdin.write(Buffer.concat([
        Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
        payload
      ]));
      return true;
    } catch {
      return false;
    }
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const separator = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(separator + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = separator + 4;
      if (this.buffer.length < start + length) return;
      const payload = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.handle(JSON.parse(payload));
      } catch (error) {
        this.fail(error);
      }
    }
  }

  handle(message) {
    if (message.method === "textDocument/publishDiagnostics") {
      this.publishDiagnostics(message.params);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "Go++ language server request failed"));
    else pending.resolve(message.result);
  }

  publishDiagnostics(params = {}) {
    const uri = params.uri ? vscode.Uri.parse(params.uri) : undefined;
    if (!uri) return;
    const diagnostics = (params.diagnostics || []).map((diagnostic) => {
      const range = toRange(diagnostic.range);
      const severity = diagnostic.severity === 2
        ? vscode.DiagnosticSeverity.Warning
        : diagnostic.severity === 3
          ? vscode.DiagnosticSeverity.Information
          : vscode.DiagnosticSeverity.Error;
      const result = new vscode.Diagnostic(range, diagnostic.message || "", severity);
      result.source = diagnostic.source || "gpp";
      if (diagnostic.code !== undefined) result.code = String(diagnostic.code);
      return result;
    });
    this.diagnostics.set(uri, diagnostics);
  }

  open(document) {
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: document.uri.toString(),
        languageId: "gpp",
        version: document.version,
        text: document.getText()
      }
    });
  }

  change(event) {
    this.notify("textDocument/didChange", {
      textDocument: { uri: event.document.uri.toString(), version: event.document.version },
      // The Go++ server advertises TextDocumentSyncKind.Full (1), so every
      // change notification must contain the full current document text.
      contentChanges: [{ text: event.document.getText() }]
    });
  }

  save(document) {
    this.notify("textDocument/didSave", { textDocument: { uri: document.uri.toString() } });
  }

  close(document) {
    this.notify("textDocument/didClose", { textDocument: { uri: document.uri.toString() } });
    this.diagnostics.delete(document.uri);
  }

  fail(error) {
    if (this.reportedFailure || this.disposed) return;
    this.reportedFailure = true;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    const message = error.code === "ENOENT"
      ? "The gpp executable was not found. Install Go++ or set gpp.lsp.command to its path."
      : error.message;
    const output = this.lastServerOutput ? ` (${this.lastServerOutput})` : "";
    this.outputChannel.appendLine(`Language server unavailable: ${message}${output}`);
    vscode.window.showWarningMessage(`Go++ language server unavailable: ${message}${output}`);
  }

  dispose() {
    const processHandle = this.process;
    const shouldShutdown = Boolean(processHandle && !processHandle.killed && this.initialized);
    let shutdownId = null;
    if (shouldShutdown) {
      shutdownId = this.nextRequestId++;
      this.pending.set(shutdownId, {
        resolve: () => {
          this.write({ jsonrpc: "2.0", method: "exit", params: null });
          processHandle.kill();
        },
        reject: () => processHandle.kill()
      });
    }
    this.disposed = true;
    this.diagnostics.dispose();
    for (const [id, pending] of this.pending.entries()) {
      if (id !== shutdownId) pending.reject(new Error("Go++ language server stopped"));
    }
    if (!shouldShutdown) {
      this.pending.clear();
      if (processHandle && !processHandle.killed) processHandle.kill();
    } else {
      for (const id of this.pending.keys()) {
        if (id !== shutdownId) this.pending.delete(id);
      }
      this.write({ jsonrpc: "2.0", id: shutdownId, method: "shutdown", params: null });
      setTimeout(() => {
        if (processHandle && !processHandle.killed) processHandle.kill();
      }, 500);
    }
  }
}

function isGoPlusDocument(document) {
  return document.languageId === "gpp" || document.fileName.endsWith(".gpp") || document.fileName.endsWith(".gpp.tpl");
}

function toLspPosition(position) {
  return { line: position.line, character: position.character };
}

function toLspRange(range) {
  return { start: toLspPosition(range.start), end: toLspPosition(range.end) };
}

function toPosition(position = {}) {
  return new vscode.Position(Math.max(0, position.line || 0), Math.max(0, position.character || 0));
}

function toRange(range = {}) {
  return new vscode.Range(toPosition(range.start), toPosition(range.end));
}

function toLocation(location) {
  if (!location) return undefined;
  const uri = location.uri || location.targetUri;
  const range = location.range || location.targetSelectionRange || location.targetRange;
  if (!uri || !range) return undefined;
  return new vscode.Location(vscode.Uri.parse(uri), toRange(range));
}

function flattenLocations(result) {
  if (!result) return [];
  const values = Array.isArray(result) ? result : [result];
  return values.map(toLocation).filter(Boolean);
}

function markdown(value) {
  if (!value) return undefined;
  if (typeof value === "string") return new vscode.MarkdownString(value);
  if (Array.isArray(value)) return new vscode.MarkdownString(value.map(markdownText).join("\n\n"));
  return new vscode.MarkdownString(markdownText(value));
}

function markdownText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.value === "string") return value.kind === "markdown" ? value.value : value.value;
  return String(value ?? "");
}

function registerLanguageFeatures(context, server) {
  const selector = [
    { language: "gpp", scheme: "file" },
    { pattern: "**/*.gpp.tpl" }
  ];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems(document, position) {
        return server.requestWhenReady("textDocument/completion", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        }).then((result) => (result || []).map((item) => {
          const completion = new vscode.CompletionItem(item.label, toCompletionItemKind(item.kind));
          completion.detail = item.detail;
          completion.documentation = markdown(item.documentation);
          completion.deprecated = Boolean(item.deprecated);
          if (item.insertText) completion.insertText = item.insertText;
          return completion;
        }));
      }
    }, ".", "@"),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        return server.requestWhenReady("textDocument/hover", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        }).then((result) => result ? new vscode.Hover(markdown(result.contents), result.range ? toRange(result.range) : undefined) : undefined);
      }
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position) {
        const params = {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        };
        return server.requestWhenReady("textDocument/definition", params).then((result) => {
          const locations = flattenLocations(result);
          if (locations.length) {
            server.outputChannel.appendLine(
              `Definition request ${document.uri.fsPath}:${position.line + 1}:${position.character + 1} returned ${locations.length} location(s)`
            );
            return locations;
          }

          const wordRange = document.getWordRangeAtPosition(position);
          if (!wordRange) return [];
          const name = document.getText(wordRange);
          return server.requestWhenReady("workspace/symbol", { query: name }).then((symbols) => {
            const fallback = (symbols || [])
              .filter((symbol) => symbol.name === name)
              .map((symbol) => toLocation(symbol.location))
              .filter(Boolean);
            server.outputChannel.appendLine(
              `Definition request ${document.uri.fsPath}:${position.line + 1}:${position.character + 1} returned ${fallback.length} workspace symbol match(es) for ${name}`
            );
            return fallback;
          });
        }, (error) => {
          server.outputChannel.appendLine(`Definition request failed: ${error.message}`);
          throw error;
        });
      }
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(document, position, context) {
        return server.requestWhenReady("textDocument/references", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position),
          context: { includeDeclaration: context.includeDeclaration }
        }).then(flattenLocations);
      }
    }),
    vscode.languages.registerRenameProvider(selector, {
      provideRenameEdits(document, position, newName) {
        return server.requestWhenReady("textDocument/rename", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position),
          newName
        }).then((result) => {
          const edit = new vscode.WorkspaceEdit();
          for (const [uri, edits] of Object.entries(result?.changes || {})) {
            for (const change of edits || []) edit.replace(vscode.Uri.parse(uri), toRange(change.range), change.newText || "");
          }
          return edit;
        });
      }
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(document) {
        return server.requestWhenReady("textDocument/documentSymbol", {
          textDocument: { uri: document.uri.toString() }
        }).then((symbols) => (symbols || []).map((symbol) => toDocumentSymbol(symbol, document.uri)));
      }
    }),
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query) {
        return server.requestWhenReady("workspace/symbol", { query }).then((symbols) =>
          (symbols || []).filter((symbol) => symbol.location).map((symbol) => {
            const result = new vscode.SymbolInformation(
              symbol.name || "",
              symbol.kind || vscode.SymbolKind.Namespace,
              toLocation(symbol.location),
              symbol.containerName
            );
            if (symbol.deprecated) result.tags = [vscode.SymbolTag.Deprecated];
            return result;
          })
        );
      }
    }),
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(document, options) {
        return formatDocumentWithGpp(document);
      }
    }),
    vscode.languages.registerSignatureHelpProvider(selector, {
      provideSignatureHelp(document, position) {
        return server.requestWhenReady("textDocument/signatureHelp", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        }).then((result) => {
          if (!result) return undefined;
          const help = new vscode.SignatureHelp();
          help.activeSignature = result.activeSignature || 0;
          help.activeParameter = result.activeParameter || 0;
          help.signatures = (result.signatures || []).map((signature) => {
            const item = new vscode.SignatureInformation(signature.label || "", markdownText(signature.documentation));
            item.parameters = (signature.parameters || []).map((parameter) => new vscode.ParameterInformation(parameter.label || "", markdownText(parameter.documentation)));
            return item;
          });
          return help;
        });
      }
    }, "(", ",")
  );

  const watchers = [
    vscode.workspace.createFileSystemWatcher("**/*.gpp"),
    vscode.workspace.createFileSystemWatcher("**/*.gpp.tpl")
  ];
  for (const watcher of watchers) {
    watcher.onDidCreate((uri) => notifyFileChange(server, uri, 1));
    watcher.onDidChange((uri) => notifyFileChange(server, uri, 2));
    watcher.onDidDelete((uri) => notifyFileChange(server, uri, 3));
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(vscode.commands.registerTextEditorCommand("gpp.formatDocument", async (editor) => {
    if (editor.document.languageId !== "gpp") return;
    try {
      const edits = await formatDocumentWithGpp(editor.document);
      if (edits.length) {
        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const edit of edits) workspaceEdit.replace(editor.document.uri, edit.range, edit.newText);
        await vscode.workspace.applyEdit(workspaceEdit);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Go++ formatting failed: ${error.message}`);
    }
  }));
}

function registerProjectCommands(context, outputChannel) {
  const actions = [
    ["runProject", "Run", undefined],
    ["buildProject", "Build", vscode.TaskGroup.Build],
    ["testProject", "Test", vscode.TaskGroup.Test]
  ];
  for (const [commandId, action, group] of actions) {
    context.subscriptions.push(vscode.commands.registerCommand(`gpp.${commandId}`, async () => {
      const document = vscode.window.activeTextEditor?.document;
      const activeFolder = document && vscode.workspace.getWorkspaceFolder(document.uri);
      const folder = activeFolder || vscode.workspace.workspaceFolders?.[0];
      if (!folder && !document) {
        vscode.window.showErrorMessage("Open a Go++ project or source file first.");
        return;
      }
      const dirtySources = vscode.workspace.textDocuments.filter((source) => isGoPlusDocument(source) && source.isDirty);
      const savedSources = await Promise.all(dirtySources.map((source) => source.save()));
      if (savedSources.some((saved) => !saved)) return;

      const cwd = folder?.uri.fsPath || path.dirname(document.uri.fsPath);
      const target = folder ? "." : path.basename(document.fileName);
      const executable = resolveGppCommand(vscode.workspace.getConfiguration("gpp.lsp").get("command", "~/go/bin/gpp"));
      const task = new vscode.Task(
        { type: "shell" },
        folder || vscode.TaskScope.Workspace,
        `Go++ ${action} Project`,
        "Go++",
        new vscode.ProcessExecution(executable, [action.toLowerCase(), target], { cwd })
      );
      if (group) task.group = group;
      task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        focus: action === "Run",
        panel: vscode.TaskPanelKind.Dedicated
      };
      outputChannel.appendLine(`Starting gpp ${action.toLowerCase()} ${target} in ${cwd}`);
      try {
        await vscode.tasks.executeTask(task);
      } catch (error) {
        outputChannel.appendLine(`Could not start gpp ${action.toLowerCase()}: ${error.message}`);
        vscode.window.showErrorMessage(`Could not start Go++ ${action.toLowerCase()}: ${error.message}`);
      }
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand("gpp.showOutput", () => outputChannel.show(true)));
}

function resolveGppCommand(command) {
  return typeof command === "string" && command.startsWith("~/")
    ? path.join(os.homedir(), command.slice(2))
    : command;
}

async function formatDocumentWithGpp(document) {
  const configuredCommand = vscode.workspace.getConfiguration("gpp.lsp").get("command", "~/go/bin/gpp");
  const command = resolveGppCommand(configuredCommand);
  const suffix = document.fileName.toLowerCase().endsWith(".gpp.tpl") ? ".gpp.tpl" : ".gpp";
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gpp-vscode-format-"));
  const temporaryFile = path.join(temporaryDirectory, `document${suffix}`);

  try {
    await fs.writeFile(temporaryFile, document.getText(), "utf8");
    const formatted = await new Promise((resolve, reject) => {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const processHandle = spawn(command, ["fmt", "--stdout", temporaryFile], {
        cwd: workspaceFolder?.uri.fsPath,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout = [];
      const stderr = [];
      processHandle.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      processHandle.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      processHandle.on("error", reject);
      processHandle.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
        else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `gpp fmt exited with code ${code}`));
      });
    });

    const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
    return formatted === document.getText() ? [] : [vscode.TextEdit.replace(fullRange, formatted)];
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// gpp lsp currently returns its symbol-kind value in CompletionItem.kind.
// Convert those SymbolKind values to VS Code's distinct CompletionItemKind enum.
function toCompletionItemKind(kind) {
  const kinds = {
    5: vscode.CompletionItemKind.Class,
    6: vscode.CompletionItemKind.Method,
    8: vscode.CompletionItemKind.Field,
    10: vscode.CompletionItemKind.Enum,
    12: vscode.CompletionItemKind.Function,
    13: vscode.CompletionItemKind.Reference,
    22: vscode.CompletionItemKind.EnumMember
  };
  return kinds[kind] || vscode.CompletionItemKind.Text;
}

function notifyFileChange(server, uri, type) {
  server.whenReady(() => server.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: uri.toString(), type }]
  }));
}

function toDocumentSymbol(symbol, uri) {
  if (symbol.selectionRange) {
    const result = new vscode.DocumentSymbol(
      symbol.name || "",
      symbol.detail || "",
      symbol.kind || vscode.SymbolKind.Namespace,
      toRange(symbol.range),
      toRange(symbol.selectionRange)
    );
    result.children = (symbol.children || []).map((child) => toDocumentSymbol(child, uri));
    result.tags = symbol.deprecated
      ? [vscode.SymbolTag.Deprecated]
      : (symbol.tags || []);
    return result;
  }
  return new vscode.SymbolInformation(
    symbol.name || "",
    symbol.kind || vscode.SymbolKind.Namespace,
    toRange(symbol.range),
    uri,
    symbol.containerName
  );
}

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("Go++");
  context.subscriptions.push(outputChannel);
  const server = new GppLanguageServer(outputChannel);
  context.subscriptions.push(server);
  server.listen(context);
  registerLanguageFeatures(context, server);
  registerProjectCommands(context, outputChannel);
  server.start().catch((error) => server.fail(error));
}

function deactivate() {}

module.exports = { activate, deactivate };
