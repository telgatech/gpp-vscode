function toLspRange(range) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function toVSCodeSeverity(severity) {
  // VS Code DiagnosticSeverity is zero-based; LSP DiagnosticSeverity is one-based.
  return ({ 1: 0, 2: 1, 3: 2, 4: 3 })[severity] ?? 0;
}

function toLspDiagnostic(diagnostic) {
  const severity = [1, 2, 3, 4][diagnostic.severity] || 1;
  const result = {
    range: toLspRange(diagnostic.range),
    severity,
    code: diagnostic.code,
    source: diagnostic.source,
    message: diagnostic.message,
    data: diagnostic.data
  };
  if (Array.isArray(diagnostic.relatedInformation)) {
    result.relatedInformation = diagnostic.relatedInformation.map((info) => ({
      location: {
        uri: info.location.uri.toString(),
        range: toLspRange(info.location.range)
      },
      message: info.message
    }));
  }
  return result;
}

module.exports = { toLspDiagnostic, toVSCodeSeverity };
