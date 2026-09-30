# Go++ Language Support

Production VS Code language support for Go++ (`.gpp` and `.gpp.tpl` files).

## Included

- Syntax highlighting for Go-compatible syntax and Go++ extensions including classes, enums, extensions, records, annotations, lambdas, safe access, error fallback, interpolation in interpreted and raw strings, and HTML templates with Go template actions
- Bracket matching, auto-closing pairs, indentation, and code folding
- Snippets for declarations, control flow, annotations, records, templates, and expressions
- Optional integration with the Go++ language server for diagnostics, completion, hover, navigation, rename, document and workspace symbols, and signature help
- Document formatting through the compiler's `gpp fmt --stdout` command, including unsaved editor buffers
- Project commands for running, building, and testing from the Command Palette or VS Code Tasks
- A Go++ output channel for language-server startup errors and compiler logs
- Snippets for import blocks and the `atExit` program-exit hook
- Workspace file watching so changes to closed `.gpp` and `.gpp.tpl` files refresh compiler diagnostics and indexes

## Language server

The extension starts `gpp lsp` automatically when a Go++ file is opened. By
default it looks for `~/go/bin/gpp`; configure another executable if needed:

```json
{
  "gpp.lsp.command": "/path/to/gpp",
  "gpp.lsp.enabled": true
}
```

Set `gpp.lsp.enabled` to `false` when using the extension as syntax-only support.

## Development

No Markdown plugin is required; this README is only documentation. To run the
extension locally:

1. Open the repository folder in VS Code, not just the README file.
2. Open **Run and Debug** and choose **Run Go++ Extension**, or press `F5`.
3. In the new Extension Development Host window, open or create a `.gpp` or
   `.gpp.tpl` file.

The repository includes `.vscode/launch.json` for the Extension Development
Host. Syntax highlighting works without the Go++ CLI; install `gpp` and keep
`gpp.lsp.enabled` enabled only when language-server features are wanted.

The grammar, language configuration, snippets, and LSP bridge are plain source
files and do not require a build step.
