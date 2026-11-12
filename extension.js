const vscode = require("vscode");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const extensionVersion = require("./package.json").version;
const { toLspDiagnostic, toVSCodeSeverity } = require("./lsp_diagnostic");
const { normalizeCompletionResult } = require("./lsp_completion");
const { decodeSemanticTokens } = require("./lsp_semantic_tokens");

class GppLanguageServer {
  constructor(outputChannel) {
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.nextRequestId = 1;
    this.pending = new Map();
    this.changeTimers = new Map();
    this.progress = new Map();
    this.diagnosticResultIds = new Map();
    this.workspaceDiagnosticUris = new Set();
    this.workspaceDiagnosticTimer = null;
    this.documentListeners = [];
    this.diagnostics = vscode.languages.createDiagnosticCollection("gpp");
    this.outputChannel = outputChannel;
    this.initialized = false;
    this.serverCapabilities = {};
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
        this.fail(new Error(`GPP language server exited (${code ?? signal ?? "unknown"})`));
      }
    });

    this.ready = this.initialize(workspaceFolder);
    await this.ready;

    for (const document of vscode.workspace.textDocuments) {
      if (isGoPlusDocument(document)) {
        this.open(document);
      }
    }
      this.scheduleWorkspaceDiagnostics(0);
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
        window: { workDoneProgress: true },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          applyEdit: true,
          diagnostics: { refreshSupport: true },
          symbol: { resolveSupport: { properties: ["location.range"] } }
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
          completion: { completionItem: {
            snippetSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ["detail", "documentation", "additionalTextEdits"] }
          } },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          documentHighlight: {},
          documentRangeFormatting: { rangesSupport: true },
          foldingRange: {},
          selectionRange: {},
          documentLink: { linkSupport: true, resolveSupport: { properties: ["target", "tooltip"] } },
          inlayHint: { resolveSupport: { properties: ["tooltip", "textEdits"] } },
          codeLens: { resolveSupport: { properties: ["command"] } },
          callHierarchy: {},
          typeHierarchy: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { dataSupport: true, relatedInformation: true },
          diagnostic: { relatedDocumentSupport: true },
          semanticTokens: { requests: { full: { delta: true }, range: true }, tokenTypes: semanticTokenTypes, tokenModifiers: semanticTokenModifiers, formats: ["relative"], overlappingTokenSupport: false, multilineTokenSupport: false },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "source.fixAll", "source.organizeImports", "refactor"] } }, dataSupport: true }
        }
      },
      clientInfo: { name: "GPP VS Code", version: extensionVersion }
    });
    if (!result) {
      throw new Error("GPP language server returned no initialization result");
    }
    this.initialized = true;
    const serverInfo = result.serverInfo;
    const capabilities = result.capabilities || {};
    this.serverCapabilities = capabilities;
    const featureCapabilities = {
      hover: "hoverProvider",
      completion: "completionProvider",
      definition: "definitionProvider",
      declaration: "declarationProvider",
      "type definition": "typeDefinitionProvider",
      implementation: "implementationProvider",
      references: "referencesProvider",
      "document highlights": "documentHighlightProvider",
      "folding ranges": "foldingRangeProvider",
      "selection ranges": "selectionRangeProvider",
      "document links": "documentLinkProvider",
      "inlay hints": "inlayHintProvider",
      "code lenses": "codeLensProvider",
      "call hierarchy": "callHierarchyProvider",
      "type hierarchy": "typeHierarchyProvider",
      rename: "renameProvider",
      symbols: "documentSymbolProvider",
      "workspace symbols": "workspaceSymbolProvider",
      "semantic tokens": "semanticTokensProvider",
      "pull diagnostics": "diagnosticProvider",
      "server commands": "executeCommandProvider",
      colors: "colorProvider",
      "on-type formatting": "documentOnTypeFormattingProvider",
      "range formatting": "documentRangeFormattingProvider",
      "inline completions": "inlineCompletionProvider",
      "inline values": "inlineValueProvider",
      "linked editing": "linkedEditingRangeProvider",
      "code actions": "codeActionProvider",
      formatting: "documentFormattingProvider",
      "signature help": "signatureHelpProvider"
    };
    const unsupported = Object.entries(featureCapabilities)
      .filter(([, capability]) => !capabilities[capability])
      .map(([feature]) => feature);
    this.outputChannel.appendLine(`Language server ready${serverInfo?.version ? ` (${serverInfo.name || "gpp"} ${serverInfo.version})` : ""}.`);
    if (unsupported.length) {
      this.outputChannel.appendLine(`Language server does not advertise: ${unsupported.join(", ")}. Those features may be unavailable.`);
    }
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
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => this.whenReady(() => {
        this.notify("workspace/didChangeWorkspaceFolders", {
          event: {
            added: event.added.map((folder) => ({ uri: folder.uri.toString(), name: folder.name })),
            removed: event.removed.map((folder) => ({ uri: folder.uri.toString(), name: folder.name }))
          }
        });
        this.scheduleWorkspaceDiagnostics();
      }))
    );
    context.subscriptions.push(...this.documentListeners);
  }

  whenReady(action) {
    this.ready.then(() => {
      if (!this.disposed && this.initialized) action();
    }).catch(() => {});
  }

  request(method, params, cancellationToken) {
    if (!this.process || this.process.killed || this.disposed) {
      return Promise.reject(new Error("GPP language server is unavailable"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      if (cancellationToken?.isCancellationRequested) {
        reject(new vscode.CancellationError());
        return;
      }
      let cancellationSubscription;
      const cleanup = () => {
        clearTimeout(timer);
        cancellationSubscription?.dispose();
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`GPP language server timed out handling ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); }
      });
      if (typeof cancellationToken?.onCancellationRequested === "function") {
        cancellationSubscription = cancellationToken.onCancellationRequested(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.notify("$/cancelRequest", { id });
          cleanup();
          reject(new vscode.CancellationError());
        });
      }
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        cleanup();
        reject(new Error("GPP language server input is unavailable"));
      }
    });
  }

  requestWhenReady(method, params, cancellationToken) {
    if (cancellationToken?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
    return this.ready.then((available) => available ? this.request(method, params, cancellationToken) : null);
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
    if (message.method) {
      this.handleServerMessage(message).catch((error) => {
        this.outputChannel.appendLine(`Language server message ${message.method} failed: ${error.message}`);
        if (message.id !== undefined && message.id !== null) {
          this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } });
        }
      });
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "GPP language server request failed"));
    else pending.resolve(message.result);
  }

  async handleServerMessage(message) {
    const params = message.params || {};
    switch (message.method) {
      case "textDocument/publishDiagnostics":
        this.publishDiagnostics(params);
        return;
      case "window/logMessage":
        this.outputChannel.appendLine(`[gpp lsp] ${params.message || ""}`);
        return;
      case "window/showMessage":
        if (params.type === 1) vscode.window.showErrorMessage(params.message || "GPP language server error");
        else if (params.type === 2) vscode.window.showWarningMessage(params.message || "GPP language server warning");
        return;
      case "workspace/configuration":
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          result: (params.items || []).map((item) => item.section ? vscode.workspace.getConfiguration().get(item.section) : null)
        });
        return;
      case "workspace/workspaceFolders":
        this.write({ jsonrpc: "2.0", id: message.id, result: (vscode.workspace.workspaceFolders || []).map((folder) => ({ uri: folder.uri.toString(), name: folder.name })) });
        return;
      case "workspace/applyEdit": {
        const applied = await vscode.workspace.applyEdit(toWorkspaceEdit(params.edit));
        this.write({ jsonrpc: "2.0", id: message.id, result: { applied } });
        return;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        this.write({ jsonrpc: "2.0", id: message.id, result: null });
        return;
      case "$/progress":
        this.updateProgress(params);
        return;
      default:
        if (message.id !== undefined && message.id !== null) {
          this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported client request: ${message.method}` } });
        }
    }
  }

  updateProgress(params = {}) {
    const key = JSON.stringify(params.token);
    const value = params.value || {};
    if (value.kind === "begin") {
      this.progress.get(key)?.dispose();
      this.progress.set(key, vscode.window.setStatusBarMessage(`GPP: ${value.title || "Working"}`));
    } else if (value.kind === "report") {
      this.progress.get(key)?.dispose();
      this.progress.set(key, vscode.window.setStatusBarMessage(`GPP: ${value.message || "Working"}`));
    } else if (value.kind === "end") {
      this.progress.get(key)?.dispose();
      this.progress.delete(key);
    }
  }

  publishDiagnostics(params = {}) {
    const uri = params.uri ? vscode.Uri.parse(params.uri) : undefined;
    if (!uri) return;
    this.diagnostics.set(uri, this.toDiagnostics(params.diagnostics));
  }

  scheduleWorkspaceDiagnostics(delay = 150) {
    clearTimeout(this.workspaceDiagnosticTimer);
    this.workspaceDiagnosticTimer = setTimeout(() => {
      this.workspaceDiagnosticTimer = null;
      this.pullWorkspaceDiagnostics().catch((error) => {
        if (!this.disposed) this.outputChannel.appendLine(`Workspace diagnostics request failed: ${error.message}`);
      });
    }, delay);
  }

  async pullDocumentDiagnostics(document) {
    if (!this.serverCapabilities.diagnosticProvider || !document || !isGoPlusDocument(document)) return;
    const uri = document.uri.toString();
    const report = await this.requestWhenReady("textDocument/diagnostic", {
      textDocument: { uri },
      previousResultId: this.diagnosticResultIds.get(uri)
    });
    if (!report) return;
    if (report.resultId) this.diagnosticResultIds.set(uri, report.resultId);
    if (report.kind === "full") this.diagnostics.set(document.uri, this.toDiagnostics(report.items));
  }

  async pullWorkspaceDiagnostics() {
    if (!this.initialized || this.disposed || !this.serverCapabilities.diagnosticProvider?.workspaceDiagnostics) return;
    const previousResultIds = Array.from(this.diagnosticResultIds, ([uri, value]) => ({ uri, value }));
    const report = await this.requestWhenReady("workspace/diagnostic", { previousResultIds });
    if (!report || !Array.isArray(report.items)) return;
    const seen = new Set();
    for (const item of report.items) {
      if (!item.uri) continue;
      const uri = vscode.Uri.parse(item.uri);
      const key = uri.toString();
      seen.add(key);
      if (item.resultId) this.diagnosticResultIds.set(key, item.resultId);
      if (item.kind === "full") this.diagnostics.set(uri, this.toDiagnostics(item.items));
    }
    for (const uri of this.workspaceDiagnosticUris) {
      if (!seen.has(uri)) {
        this.diagnostics.delete(vscode.Uri.parse(uri));
        this.diagnosticResultIds.delete(uri);
      }
    }
    this.workspaceDiagnosticUris = seen;
  }

  toDiagnostics(items) {
    return (items || []).map((diagnostic) => {
      const range = toRange(diagnostic.range);
      const severity = [
        vscode.DiagnosticSeverity.Error,
        vscode.DiagnosticSeverity.Warning,
        vscode.DiagnosticSeverity.Information,
        vscode.DiagnosticSeverity.Hint
      ][toVSCodeSeverity(diagnostic.severity)];
      const result = new vscode.Diagnostic(range, diagnostic.message || "", severity);
      result.source = diagnostic.source || "gpp";
      if (diagnostic.code !== undefined) result.code = String(diagnostic.code);
      if (diagnostic.data !== undefined) result.data = diagnostic.data;
      if (Array.isArray(diagnostic.relatedInformation)) {
        result.relatedInformation = diagnostic.relatedInformation.map((info) => {
          const location = toLocation(info.location);
          return location ? new vscode.DiagnosticRelatedInformation(location, info.message || "") : undefined;
        }).filter(Boolean);
      }
      return result;
    });
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
    this.pullDocumentDiagnostics(document).catch((error) => {
      if (!this.disposed) this.outputChannel.appendLine(`Diagnostics request failed for ${document.uri}: ${error.message}`);
    });
  }

  change(event) {
    const change = {
      uri: event.document.uri.toString(),
      version: event.document.version,
      text: event.document.getText()
    };
    const previous = this.changeTimers.get(change.uri);
    if (previous) clearTimeout(previous.timer);
    const pending = {
      timer: setTimeout(() => {
        if (this.changeTimers.get(change.uri) !== pending) return;
        this.changeTimers.delete(change.uri);
        this.sendChange(change);
      }, 100)
    };
    this.changeTimers.set(change.uri, pending);
  }

  flushChange(document) {
    const uri = document.uri.toString();
    const pending = this.changeTimers.get(uri);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.changeTimers.delete(uri);
    this.sendChange({ uri, version: document.version, text: document.getText() });
  }

  sendChange(change) {
    this.notify("textDocument/didChange", {
      textDocument: { uri: change.uri, version: change.version },
      // The server advertises incremental sync. A change without a range is a
      // valid full-document replacement, which keeps updates simple here.
      contentChanges: [{ text: change.text }]
    });
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === change.uri);
    if (document) this.pullDocumentDiagnostics(document).catch((error) => {
      if (!this.disposed) this.outputChannel.appendLine(`Diagnostics request failed for ${change.uri}: ${error.message}`);
    });
    this.scheduleWorkspaceDiagnostics();
  }

  save(document) {
    this.flushChange(document);
    this.notify("textDocument/didSave", { textDocument: { uri: document.uri.toString() } });
    this.pullDocumentDiagnostics(document).catch((error) => {
      if (!this.disposed) this.outputChannel.appendLine(`Diagnostics request failed for ${document.uri}: ${error.message}`);
    });
    this.scheduleWorkspaceDiagnostics();
  }

  close(document) {
    this.flushChange(document);
    this.notify("textDocument/didClose", { textDocument: { uri: document.uri.toString() } });
    this.diagnostics.delete(document.uri);
    this.diagnosticResultIds.delete(document.uri.toString());
    this.scheduleWorkspaceDiagnostics();
  }

  fail(error) {
    if (this.reportedFailure || this.disposed) return;
    this.reportedFailure = true;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    const message = error.code === "ENOENT"
      ? "The gpp executable was not found. Install GPP or set gpp.lsp.command to its path."
      : error.message;
    const output = this.lastServerOutput ? ` (${this.lastServerOutput})` : "";
    this.outputChannel.appendLine(`Language server unavailable: ${message}${output}`);
    vscode.window.showWarningMessage(`GPP language server unavailable: ${message}${output}`);
  }

  dispose() {
    clearTimeout(this.workspaceDiagnosticTimer);
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
    for (const pending of this.changeTimers.values()) clearTimeout(pending.timer);
    this.changeTimers.clear();
    this.diagnostics.dispose();
    for (const progress of this.progress.values()) progress.dispose();
    this.progress.clear();
    for (const [id, pending] of this.pending.entries()) {
      if (id !== shutdownId) pending.reject(new Error("GPP language server stopped"));
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

function toLSPHierarchyItem(item) {
  return {
    name: item.name, kind: item.kind, detail: item.detail, uri: item.uri.toString(),
    range: toLspRange(item.range), selectionRange: toLspRange(item.selectionRange), data: item.data
  };
}

function toVSCallHierarchyItem(item) {
  const value = new vscode.CallHierarchyItem(
    item.kind, item.name, item.detail || "", vscode.Uri.parse(item.uri), toRange(item.range), toRange(item.selectionRange)
  );
  value.data = item.data;
  return value;
}

function toVSTypeHierarchyItem(item) {
  const value = new vscode.TypeHierarchyItem(
    item.kind, item.name, item.detail || "", vscode.Uri.parse(item.uri), toRange(item.range), toRange(item.selectionRange)
  );
  value.data = item.data;
  return value;
}

function toSelectionRange(value) {
  if (!value) return undefined;
  return new vscode.SelectionRange(toRange(value.range), toSelectionRange(value.parent));
}

function toSemanticTokens(result) {
  const builder = new vscode.SemanticTokensBuilder(semanticTokenLegend);
  for (const token of decodeSemanticTokens(result, semanticTokenTypes.length)) {
    builder.push(token.line, token.character, token.length, token.tokenType, token.tokenModifiers);
  }
  return builder.build();
}

function toWorkspaceEdit(value) {
  const edit = new vscode.WorkspaceEdit();
  if (value?.changes) {
    for (const [uri, edits] of Object.entries(value.changes)) {
      for (const change of edits || []) edit.replace(vscode.Uri.parse(uri), toRange(change.range), change.newText || "");
    }
  }
  for (const change of value?.documentChanges || []) {
    if (change.textDocument && Array.isArray(change.edits)) {
      const uri = vscode.Uri.parse(change.textDocument.uri);
      for (const item of change.edits) {
        if (item.range) edit.replace(uri, toRange(item.range), item.newText || "");
      }
    } else if (change.kind === "create") {
      edit.createFile(vscode.Uri.parse(change.uri), { overwrite: change.options?.overwrite, ignoreIfExists: change.options?.ignoreIfExists });
    } else if (change.kind === "delete") {
      edit.deleteFile(vscode.Uri.parse(change.uri), { recursive: change.options?.recursive, ignoreIfNotExists: change.options?.ignoreIfNotExists });
    } else if (change.kind === "rename") {
      edit.renameFile(vscode.Uri.parse(change.oldUri), vscode.Uri.parse(change.newUri), { overwrite: change.options?.overwrite, ignoreIfExists: change.options?.ignoreIfExists });
    }
  }
  return edit;
}

function toCodeLensCommand(command, fallbackUri) {
  return {
    title: command.title || "GPP references",
    command: command.command,
    arguments: (command.arguments || []).map((argument) => {
      if (!argument || typeof argument !== "object" || !("position" in argument) && !argument.locations) return argument;
      return {
        uri: argument.uri ? vscode.Uri.parse(argument.uri) : fallbackUri,
        position: toPosition(argument.position),
        locations: flattenLocations(argument.locations)
      };
    })
  };
}

function workspaceEditHasChanges(value) {
  if (!value) return false;
  if (Object.values(value.changes || {}).some((edits) => Array.isArray(edits) && edits.length > 0)) return true;
  return Array.isArray(value.documentChanges) && value.documentChanges.length > 0;
}

function markdown(value) {
  if (!value) return undefined;
  const text = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(markdownText).filter(Boolean).join("\n\n")
      : markdownText(value);
  return text.trim() ? new vscode.MarkdownString(text) : undefined;
}

function markdownText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.value === "string") return value.kind === "markdown" ? value.value : value.value;
  return String(value ?? "");
}

function registerLanguageFeatures(context, server) {
  const selector = [
    { language: "gpp" },
    { pattern: "**/*.gpp.tpl" }
  ];
  const pendingCompletions = new Map();
  const tracedMemberCompletions = new Set();
  const completionPayloads = new WeakMap();
  const codeActionPayloads = new WeakMap();
  const workspaceSymbolPayloads = new WeakMap();
  const documentLinkPayloads = new WeakMap();
  const inlayHintPayloads = new WeakMap();
  const codeLensPayloads = new WeakMap();

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems(document, position, token, _completionContext) {
        if (token.isCancellationRequested) return [];
        const key = document.uri.toString();
        const prefix = document.lineAt(position.line).text.slice(0, position.character);
        const isMemberCompletion = /[.@]\s*$/.test(prefix);
        if (isMemberCompletion && !tracedMemberCompletions.has(key)) {
          tracedMemberCompletions.add(key);
          server.outputChannel.appendLine(`Member completion provider entered for ${document.uri}.`);
        }
        const previous = pendingCompletions.get(key);
        if (previous) {
          clearTimeout(previous.timer);
          previous.subscription?.dispose();
          pendingCompletions.delete(key);
          previous.resolve([]);
        }

        return new Promise((resolve) => {
          const pending = { resolve, timer: undefined, subscription: undefined };
          const cancel = () => {
            if (pendingCompletions.get(key) !== pending) return;
            clearTimeout(pending.timer);
            pendingCompletions.delete(key);
            pending.subscription?.dispose();
            if (isMemberCompletion) server.outputChannel.appendLine(`Member completion canceled before dispatch for ${document.uri}.`);
            resolve([]);
          };
          pending.subscription = token.onCancellationRequested(cancel);
          pending.timer = setTimeout(() => {
            if (pendingCompletions.get(key) !== pending) return;
            pendingCompletions.delete(key);
            pending.subscription?.dispose();
            server.flushChange(document);
            server.requestWhenReady("textDocument/completion", {
              textDocument: { uri: key },
              position: toLspPosition(position)
            }, token).then((result) => {
              const normalized = normalizeCompletionResult(result);
              if (isMemberCompletion) server.outputChannel.appendLine(`Member completion received ${normalized.items.length} item(s) for ${document.uri}.`);
              const completions = normalized.items.map((item) => {
                const completion = new vscode.CompletionItem(item.label, toCompletionItemKind(item.kind));
                completionPayloads.set(completion, item);
                completion.detail = item.detail;
                completion.documentation = markdown(item.documentation);
                completion.deprecated = Boolean(item.deprecated);
                completion.data = item.data;
                if (item.sortText) completion.sortText = item.sortText;
                if (item.filterText) {
                  completion.filterText = item.filterText;
                } else if (isMemberCompletion && item.textEdit?.range?.start?.line === position.line && item.textEdit.range.start.character < position.character) {
                  const leadingText = document.getText(new vscode.Range(toPosition(item.textEdit.range.start), position));
                  if (leadingText && !String(item.label).startsWith(leadingText)) {
                    completion.filterText = `${leadingText}${item.label}`;
                  }
                }
                const insertText = item.textEdit?.newText ?? item.insertText ?? item.label;
                if (item.insertTextFormat === 2) completion.insertText = new vscode.SnippetString(insertText);
                else if (insertText !== undefined) completion.insertText = insertText;
                if (item.textEdit?.range) completion.range = item.textEdit.range.insert && item.textEdit.range.replace
                  ? { inserting: toRange(item.textEdit.range.insert), replacing: toRange(item.textEdit.range.replace) }
                  : toRange(item.textEdit.range);
                if (item.additionalTextEdits) completion.additionalTextEdits = item.additionalTextEdits.map((edit) => vscode.TextEdit.replace(toRange(edit.range), edit.newText || ""));
                return completion;
              });
              return normalized.isList
                ? new vscode.CompletionList(completions, normalized.isIncomplete)
                : completions;
            }).then(resolve, (error) => {
              if (token.isCancellationRequested || error instanceof vscode.CancellationError) {
                if (isMemberCompletion) server.outputChannel.appendLine(`Member completion canceled while awaiting the server for ${document.uri}.`);
                resolve([]);
                return;
              }
              server.outputChannel.appendLine(`Completion request failed: ${error.message}`);
              resolve([]);
            });
          }, 100);
          pendingCompletions.set(key, pending);
        });
      },
      resolveCompletionItem(completion, token) {
        const payload = completionPayloads.get(completion) || { label: completion.label, data: completion.data };
        return server.requestWhenReady("completionItem/resolve", payload, token).then((resolved) => {
          if (!resolved) return completion;
          completionPayloads.set(completion, resolved);
          if (!completion.detail && resolved.detail) completion.detail = resolved.detail;
          completion.documentation = markdown(resolved.documentation) || completion.documentation;
          completion.data = resolved.data;
          if (resolved.additionalTextEdits) completion.additionalTextEdits = resolved.additionalTextEdits.map((edit) =>
            vscode.TextEdit.replace(toRange(edit.range), edit.newText || "")
          );
          return completion;
        });
      }
    }, ".", "@"),
    vscode.languages.registerInlineCompletionItemProvider(selector, {
      provideInlineCompletionItems(document, position, _context, token) {
        if (token.isCancellationRequested) return [];
        server.flushChange(document);
        return server.requestWhenReady("textDocument/inlineCompletion", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        }, token).then((items) => (Array.isArray(items) ? items : items?.items || []).map((item) => {
          const rawText = item.insertText;
          const insertText = rawText && typeof rawText === "object" && rawText.kind === "snippet"
            ? new vscode.SnippetString(rawText.value || "")
            : rawText || "";
          const completion = new vscode.InlineCompletionItem(insertText, item.range ? toRange(item.range) : undefined);
          completion.filterText = item.filterText;
          if (item.command?.command) completion.command = {
            title: item.command.title || "GPP completion",
            command: item.command.command,
            arguments: item.command.arguments || []
          };
          return completion;
        })).catch((error) => {
          if (token.isCancellationRequested || error instanceof vscode.CancellationError) return [];
          server.outputChannel.appendLine(`Inline completion request failed: ${error.message}`);
          return [];
        });
      }
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position, token) {
        server.flushChange(document);
        const params = {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        };
        return server.requestWhenReady("textDocument/hover", params, token).then((result) => {
          return result && markdown(result.contents)
            ? new vscode.Hover(markdown(result.contents), result.range ? toRange(result.range) : undefined)
            : undefined;
        }).catch((error) => {
          if (token.isCancellationRequested || error instanceof vscode.CancellationError) return undefined;
          server.outputChannel.appendLine(`Hover request failed for ${document.uri.fsPath}:${position.line + 1}:${position.character + 1}: ${error.message}`);
          return undefined;
        });
      }
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position, token) {
        server.flushChange(document);
        const params = {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        };
        return server.requestWhenReady("textDocument/definition", params, token).then(flattenLocations, (error) => {
          if (token.isCancellationRequested || error instanceof vscode.CancellationError) return [];
          server.outputChannel.appendLine(`Definition request failed: ${error.message}`);
          throw error;
        });
      }
    }),
    vscode.languages.registerDeclarationProvider(selector, {
      provideDeclaration(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/declaration", {
          textDocument: { uri: document.uri.toString() }, position: toLspPosition(position)
        }, token).then(flattenLocations);
      }
    }),
    vscode.languages.registerTypeDefinitionProvider(selector, {
      provideTypeDefinition(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/typeDefinition", {
          textDocument: { uri: document.uri.toString() }, position: toLspPosition(position)
        }, token).then(flattenLocations);
      }
    }),
    vscode.languages.registerImplementationProvider(selector, {
      provideImplementation(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/implementation", {
          textDocument: { uri: document.uri.toString() }, position: toLspPosition(position)
        }, token).then(flattenLocations);
      }
    }),
    vscode.languages.registerDocumentHighlightProvider(selector, {
      provideDocumentHighlights(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/documentHighlight", {
          textDocument: { uri: document.uri.toString() }, position: toLspPosition(position)
        }, token).then((items) => (items || []).map((item) => new vscode.DocumentHighlight(
          toRange(item.range), item.kind === 3 ? vscode.DocumentHighlightKind.Write : item.kind === 2 ? vscode.DocumentHighlightKind.Read : vscode.DocumentHighlightKind.Text
        )));
      }
    }),
    vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges(document, _context, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/foldingRange", {
          textDocument: { uri: document.uri.toString() }
        }, token).then((items) => (items || []).map((item) => new vscode.FoldingRange(
          item.startLine, item.endLine, item.kind === "comment" ? vscode.FoldingRangeKind.Comment : item.kind === "region" ? vscode.FoldingRangeKind.Region : undefined
        )));
      }
    }),
    vscode.languages.registerSelectionRangeProvider(selector, {
      provideSelectionRanges(document, positions, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/selectionRange", {
          textDocument: { uri: document.uri.toString() }, positions: positions.map(toLspPosition)
        }, token).then((items) => (items || []).map(toSelectionRange));
      }
    }),
    vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks(document, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/documentLink", {
          textDocument: { uri: document.uri.toString() }
        }, token).then((items) => (items || []).map((item) => {
          const link = new vscode.DocumentLink(toRange(item.range), item.target ? vscode.Uri.parse(item.target) : undefined);
          link.tooltip = item.tooltip;
          link.data = item.data;
          documentLinkPayloads.set(link, item);
          return link;
        }));
      },
      resolveDocumentLink(link, token) {
        const payload = documentLinkPayloads.get(link) || { range: toLspRange(link.range), data: link.data };
        if (!payload) return link;
        return server.requestWhenReady("documentLink/resolve", payload, token).then((resolved) => {
          if (!resolved) return link;
          documentLinkPayloads.set(link, resolved);
          if (resolved.range) link.range = toRange(resolved.range);
          if (resolved.target) link.target = vscode.Uri.parse(resolved.target);
          if (resolved.tooltip) link.tooltip = resolved.tooltip;
          link.data = resolved.data;
          return link;
        });
      }
    }),
    vscode.languages.registerColorProvider(selector, {
      provideDocumentColors(document, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/documentColor", {
          textDocument: { uri: document.uri.toString() }
        }, token).then((items) => (items || []).map((item) => new vscode.ColorInformation(
          toRange(item.range), new vscode.Color(item.color.red, item.color.green, item.color.blue, item.color.alpha)
        )));
      },
      provideColorPresentations(color, context, token) {
        server.flushChange(context.document);
        return server.requestWhenReady("textDocument/colorPresentation", {
          textDocument: { uri: context.document.uri.toString() },
          color: { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha },
          range: toLspRange(context.range)
        }, token).then((items) => (items || []).map((item) => {
          const presentation = new vscode.ColorPresentation(item.label || "");
          if (item.textEdit) presentation.textEdit = vscode.TextEdit.replace(toRange(item.textEdit.range), item.textEdit.newText || "");
          if (item.additionalTextEdits) presentation.additionalTextEdits = item.additionalTextEdits.map((edit) =>
            vscode.TextEdit.replace(toRange(edit.range), edit.newText || "")
          );
          return presentation;
        }));
      }
    }),
    vscode.languages.registerInlayHintsProvider(selector, {
      provideInlayHints(document, range, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/inlayHint", {
          textDocument: { uri: document.uri.toString() }, range: toLspRange(range)
        }, token).then((items) => {
          const hints = items || [];
          return hints.map((item) => {
            const hint = new vscode.InlayHint(
              toPosition(item.position), item.label, item.kind === 1 ? vscode.InlayHintKind.Type : vscode.InlayHintKind.Parameter
            );
            hint.paddingLeft = Boolean(item.paddingLeft);
            hint.paddingRight = Boolean(item.paddingRight);
            hint.tooltip = markdown(item.tooltip) || item.tooltip;
            if (item.textEdits) hint.textEdits = item.textEdits.map((edit) =>
              vscode.TextEdit.replace(toRange(edit.range), edit.newText || "")
            );
            hint.data = item.data;
            inlayHintPayloads.set(hint, item);
            return hint;
          });
        });
      },
      resolveInlayHint(hint, token) {
        const payload = inlayHintPayloads.get(hint) || {
          position: { line: hint.position.line, character: hint.position.character },
          label: typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join(""),
          data: hint.data
        };
        if (!payload) return hint;
        return server.requestWhenReady("inlayHint/resolve", payload, token).then((resolved) => {
          if (!resolved) return hint;
          inlayHintPayloads.set(hint, resolved);
          if (resolved.tooltip) hint.tooltip = markdown(resolved.tooltip) || resolved.tooltip;
          if (resolved.textEdits) hint.textEdits = resolved.textEdits.map((edit) =>
            vscode.TextEdit.replace(toRange(edit.range), edit.newText || "")
          );
          if (resolved.paddingLeft !== undefined) hint.paddingLeft = Boolean(resolved.paddingLeft);
          if (resolved.paddingRight !== undefined) hint.paddingRight = Boolean(resolved.paddingRight);
          hint.data = resolved.data;
          return hint;
        });
      }
    }),
    vscode.languages.registerInlineValuesProvider(selector, {
      provideInlineValues(document, viewPort, _context, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/inlineValue", {
          textDocument: { uri: document.uri.toString() }, range: toLspRange(viewPort)
        }, token).then((items) => (items || []).map((item) => {
          const range = toRange(item.range);
          if (item.expression !== undefined) return new vscode.InlineValueEvaluatableExpression(range, item.expression);
          if (item.variableName !== undefined || item.caseSensitiveLookup !== undefined) {
            return new vscode.InlineValueVariableLookup(range, item.variableName, item.caseSensitiveLookup);
          }
          return new vscode.InlineValueEvaluatableExpression(range);
        }));
      }
    }),
    vscode.languages.registerLinkedEditingRangeProvider(selector, {
      provideLinkedEditingRanges(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/linkedEditingRange", {
          textDocument: { uri: document.uri.toString() }, position: toLspPosition(position)
        }, token).then((result) => result?.ranges?.length
          ? new vscode.LinkedEditingRanges(result.ranges.map(toRange), result.wordPattern ? new RegExp(result.wordPattern) : undefined)
          : undefined);
      }
    }),
    vscode.languages.registerCodeLensProvider(selector, {
      provideCodeLenses(document, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/codeLens", {
          textDocument: { uri: document.uri.toString() }
        }, token).then((items) => (items || []).map((item) => {
          const lens = new vscode.CodeLens(toRange(item.range));
          if (item.command) {
            lens.command = toCodeLensCommand(item.command, document.uri);
          }
          lens.data = item.data;
          codeLensPayloads.set(lens, item);
          return lens;
        }));
      },
      resolveCodeLens(lens, token) {
        const payload = codeLensPayloads.get(lens) || { range: toLspRange(lens.range), data: lens.data };
        if (!payload) return lens;
        return server.requestWhenReady("codeLens/resolve", payload, token).then((resolved) => {
          if (!resolved) return lens;
          codeLensPayloads.set(lens, resolved);
          if (resolved.range) lens.range = toRange(resolved.range);
          if (resolved.command) {
            const fallbackUri = payload.data?.uri ? vscode.Uri.parse(payload.data.uri) : undefined;
            lens.command = toCodeLensCommand(resolved.command, fallbackUri);
          }
          lens.data = resolved.data;
          return lens;
        });
      }
    }),
    vscode.languages.registerCallHierarchyProvider(selector, {
      prepareCallHierarchy(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/prepareCallHierarchy", {
          textDocument: { uri: document.uri.toString() }, position: toLspPosition(position)
        }, token).then((items) => (items || []).map(toVSCallHierarchyItem));
      },
      provideIncomingCalls(item, token) {
        return server.requestWhenReady("callHierarchy/incomingCalls", { item: toLSPHierarchyItem(item) }, token)
          .then((items) => (items || []).map((call) => ({ from: toVSCallHierarchyItem(call.from), fromRanges: (call.fromRanges || []).map(toRange) })));
      },
      provideOutgoingCalls(item, token) {
        return server.requestWhenReady("callHierarchy/outgoingCalls", { item: toLSPHierarchyItem(item) }, token)
          .then((items) => (items || []).map((call) => ({ to: toVSCallHierarchyItem(call.to), fromRanges: (call.fromRanges || []).map(toRange) })));
      }
    }),
    vscode.languages.registerTypeHierarchyProvider(selector, {
      prepareTypeHierarchy(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/prepareTypeHierarchy", {
          textDocument: { uri: document.uri.toString() }, position: toLspPosition(position)
        }, token).then((items) => (items || []).map(toVSTypeHierarchyItem));
      },
      provideSupertypes(item, token) {
        return server.requestWhenReady("typeHierarchy/supertypes", { item: toLSPHierarchyItem(item) }, token)
          .then((items) => (items || []).map(toVSTypeHierarchyItem));
      },
      provideSubtypes(item, token) {
        return server.requestWhenReady("typeHierarchy/subtypes", { item: toLSPHierarchyItem(item) }, token)
          .then((items) => (items || []).map(toVSTypeHierarchyItem));
      }
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(document, position, context, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/references", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position),
          context: { includeDeclaration: context.includeDeclaration }
        }, token).then(flattenLocations);
      }
    }),
    vscode.languages.registerRenameProvider(selector, {
      prepareRename(document, position, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/prepareRename", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        }, token).then((result) => result ? {
          range: toRange(result.range || result),
          placeholder: result.placeholder
        } : undefined);
      },
      provideRenameEdits(document, position, newName, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/rename", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position),
          newName
        }, token).then((result) => toWorkspaceEdit(result));
      }
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(document, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/documentSymbol", {
          textDocument: { uri: document.uri.toString() }
        }, token).then((symbols) => (symbols || []).map((symbol) => toDocumentSymbol(symbol, document.uri)));
      }
    }),
    vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      provideDocumentSemanticTokens(document, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/semanticTokens/full", {
          textDocument: { uri: document.uri.toString() }
        }, token).then(toSemanticTokens);
      }
    }, semanticTokenLegend),
    vscode.languages.registerDocumentRangeSemanticTokensProvider(selector, {
      provideDocumentRangeSemanticTokens(document, range, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/semanticTokens/range", {
          textDocument: { uri: document.uri.toString() }, range: toLspRange(range)
        }, token).then(toSemanticTokens);
      }
    }, semanticTokenLegend),
    vscode.languages.registerCodeActionsProvider(selector, {
      provideCodeActions(document, range, context, token) {
        server.flushChange(document);
        const diagnostics = context.diagnostics.map(toLspDiagnostic);
        const only = context.only ? [context.only.value] : undefined;
        return server.requestWhenReady("textDocument/codeAction", {
          textDocument: { uri: document.uri.toString() },
          range: toLspRange(range),
          context: { diagnostics, only }
        }, token).then((actions) => (actions || []).map((action) => {
          const codeAction = new vscode.CodeAction(action.title || "GPP action", new vscode.CodeActionKind(action.kind || "quickfix"));
          codeActionPayloads.set(codeAction, action);
          codeAction.isPreferred = Boolean(action.isPreferred);
          codeAction.diagnostics = context.diagnostics.filter((diagnostic) =>
            (action.diagnostics || []).some((item) => String(item.code) === String(diagnostic.code) && item.message === diagnostic.message)
          );
          if (workspaceEditHasChanges(action.edit)) codeAction.edit = toWorkspaceEdit(action.edit);
          if (typeof action.command === "string") {
            codeAction.command = {
              title: action.title || "GPP action",
              command: action.command,
              arguments: action.arguments || []
            };
          } else if (action.command?.command) {
            codeAction.command = {
              title: action.command.title || action.title || "GPP action",
              command: action.command.command,
              arguments: action.command.arguments || []
            };
          }
          return codeAction;
        }));
      },
      resolveCodeAction(codeAction, token) {
        const payload = codeActionPayloads.get(codeAction);
        if (!payload) return codeAction;
        return server.requestWhenReady("codeAction/resolve", payload, token).then((resolved) => {
          if (!resolved) return codeAction;
          codeActionPayloads.set(codeAction, resolved);
          if (resolved.title) codeAction.title = resolved.title;
          if (resolved.kind) codeAction.kind = new vscode.CodeActionKind(resolved.kind);
          codeAction.isPreferred = Boolean(resolved.isPreferred);
          if (workspaceEditHasChanges(resolved.edit)) codeAction.edit = toWorkspaceEdit(resolved.edit);
          if (resolved.command?.command) codeAction.command = {
            title: resolved.command.title || resolved.title || "GPP action",
            command: resolved.command.command,
            arguments: resolved.command.arguments || []
          };
          return codeAction;
        });
      }
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorExtract, vscode.CodeActionKind.SourceFixAll, vscode.CodeActionKind.SourceOrganizeImports] }),
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query, token) {
        const workDoneToken = `workspace-symbol-${server.nextRequestId}:${query}`;
        return server.requestWhenReady("workspace/symbol", { query, workDoneToken }, token).then((symbols) =>
          (symbols || []).filter((symbol) => symbol.location).map((symbol) => {
            const uri = symbol.location.uri ? vscode.Uri.parse(symbol.location.uri) : undefined;
            if (!uri) return undefined;
            const location = symbol.location.range
              ? toLocation(symbol.location)
              : new vscode.Location(uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)));
            const result = new vscode.SymbolInformation(
              symbol.name || "",
              symbol.kind || vscode.SymbolKind.Namespace,
              symbol.containerName || "",
              location
            );
            if (!symbol.location.range) result.location = { uri };
            if (symbol.deprecated) result.tags = [vscode.SymbolTag.Deprecated];
            result.data = symbol.data;
            workspaceSymbolPayloads.set(result, symbol);
            return result;
          }).filter(Boolean)
        );
      },
      resolveWorkspaceSymbol(symbol, token) {
        const payload = workspaceSymbolPayloads.get(symbol) || {
          name: symbol.name,
          kind: symbol.kind,
          location: { uri: symbol.location.uri.toString() },
          data: symbol.data
        };
        if (!payload) return symbol;
        return server.requestWhenReady("workspaceSymbol/resolve", payload, token).then((resolved) => {
          if (resolved?.location?.uri && resolved.location.range) symbol.location = toLocation(resolved.location);
          if (resolved?.deprecated) symbol.tags = [vscode.SymbolTag.Deprecated];
          symbol.data = resolved?.data;
          workspaceSymbolPayloads.set(symbol, resolved || payload);
          return symbol;
        });
      }
    }),
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(document, options) {
        return formatDocumentWithGpp(document);
      }
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
      provideDocumentRangeFormattingEdits(document, range, options, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/rangeFormatting", {
          textDocument: { uri: document.uri.toString() }, range: toLspRange(range), options
        }, token).then((edits) => (edits || []).map((edit) => vscode.TextEdit.replace(toRange(edit.range), edit.newText || "")));
      },
      provideDocumentRangesFormattingEdits(document, ranges, options, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/rangesFormatting", {
          textDocument: { uri: document.uri.toString() }, ranges: ranges.map(toLspRange), options
        }, token).then((edits) => (edits || []).map((edit) => vscode.TextEdit.replace(toRange(edit.range), edit.newText || "")));
      }
    }),
    vscode.languages.registerOnTypeFormattingEditProvider(selector, {
      provideOnTypeFormattingEdits(document, position, character, options, token) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/onTypeFormatting", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position), ch: character, options
        }, token).then((edits) => (edits || []).map((edit) => vscode.TextEdit.replace(toRange(edit.range), edit.newText || "")));
      }
    }, "}", "\n"),
    vscode.languages.registerSignatureHelpProvider(selector, {
      provideSignatureHelp(document, position, token, _context) {
        server.flushChange(document);
        return server.requestWhenReady("textDocument/signatureHelp", {
          textDocument: { uri: document.uri.toString() },
          position: toLspPosition(position)
        }, token).then((result) => {
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
    vscode.workspace.createFileSystemWatcher("**/*.gpp.tpl"),
    vscode.workspace.createFileSystemWatcher("**/*.go"),
    vscode.workspace.createFileSystemWatcher("**/go.mod"),
    vscode.workspace.createFileSystemWatcher("**/go.sum")
  ];
  for (const watcher of watchers) {
    watcher.onDidCreate((uri) => notifyFileChange(server, uri, 1));
    watcher.onDidChange((uri) => notifyFileChange(server, uri, 2));
    watcher.onDidDelete((uri) => notifyFileChange(server, uri, 3));
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(vscode.commands.registerCommand("gpp.showReferences", (payload) => {
    if (!payload?.uri || !payload?.position) return;
    return vscode.commands.executeCommand(
      "editor.action.showReferences", payload.uri, payload.position, payload.locations || []
    );
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand("gpp.organizeImports", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || !isGoPlusDocument(document)) {
        vscode.window.showInformationMessage("Open a GPP document to organize imports.");
        return;
      }
      if (!server.serverCapabilities.executeCommandProvider?.commands?.includes("gpp.organizeImports")) {
        vscode.window.showWarningMessage("The GPP language server does not support organize imports.");
        return;
      }
      server.flushChange(document);
      try {
        const edit = await server.requestWhenReady("workspace/executeCommand", {
          command: "gpp.organizeImports", arguments: [document.uri.toString()]
        });
        if (edit) await vscode.workspace.applyEdit(toWorkspaceEdit(edit));
      } catch (error) {
        vscode.window.showErrorMessage(`GPP organize imports failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("gpp.getDiagnostics", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || !isGoPlusDocument(document)) {
        vscode.window.showInformationMessage("Open a GPP document to refresh diagnostics.");
        return;
      }
      if (!server.serverCapabilities.executeCommandProvider?.commands?.includes("gpp.getDiagnostics")) {
        vscode.window.showWarningMessage("The GPP language server does not support refreshing diagnostics.");
        return;
      }
      server.flushChange(document);
      try {
        const diagnostics = await server.requestWhenReady("workspace/executeCommand", {
          command: "gpp.getDiagnostics", arguments: [document.uri.toString()]
        });
        if (diagnostics) server.diagnostics.set(document.uri, server.toDiagnostics(diagnostics));
        await vscode.commands.executeCommand("workbench.actions.view.problems");
      } catch (error) {
        vscode.window.showErrorMessage(`GPP diagnostics request failed: ${error.message}`);
      }
    })
  );

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
      vscode.window.showErrorMessage(`GPP formatting failed: ${error.message}`);
    }
  }));
}

const semanticTokenTypes = [
  "namespace", "type", "class", "enum", "interface", "struct",
  "typeParameter", "parameter", "variable", "property", "enumMember",
  "function", "method", "macro", "keyword", "modifier", "comment",
  "string", "number", "operator", "decorator"
];
const semanticTokenModifiers = ["declaration", "readonly", "static", "deprecated", "defaultLibrary"];
const semanticTokenLegend = new vscode.SemanticTokensLegend(semanticTokenTypes, semanticTokenModifiers);

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
        vscode.window.showErrorMessage("Open a GPP project or source file first.");
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
        `GPP ${action} Project`,
        "GPP",
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
        vscode.window.showErrorMessage(`Could not start GPP ${action.toLowerCase()}: ${error.message}`);
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
  server.whenReady(() => {
    server.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: uri.toString(), type }] });
    server.scheduleWorkspaceDiagnostics();
  });
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
  const outputChannel = vscode.window.createOutputChannel("GPP");
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
