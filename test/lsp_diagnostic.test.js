const assert = require("node:assert/strict");
const test = require("node:test");
const { toLspDiagnostic, toVSCodeSeverity } = require("../lsp_diagnostic");

const range = {
  start: { line: 2, character: 4 },
  end: { line: 2, character: 9 }
};

test("serializes diagnostic related information for LSP code actions", () => {
  const actual = toLspDiagnostic({
    range,
    severity: 1,
    code: "GPP2000",
    source: "gpp",
    message: "unknown field",
    data: { fix: "example" },
    relatedInformation: [{
      location: { uri: { toString: () => "file:///workspace/model.gpp" }, range },
      message: "field declared here"
    }]
  });

  assert.deepEqual(actual.relatedInformation, [{
    location: { uri: "file:///workspace/model.gpp", range },
    message: "field declared here"
  }]);
  assert.equal(actual.severity, 2);
  assert.deepEqual(actual.data, { fix: "example" });
});

test("maps every VS Code diagnostic severity to its LSP value", () => {
  for (const [vscodeSeverity, lspSeverity] of [[0, 1], [1, 2], [2, 3], [3, 4]]) {
    assert.equal(toLspDiagnostic({ range, severity: vscodeSeverity }).severity, lspSeverity);
  }
});


test("maps every LSP diagnostic severity to VS Code", () => {
  for (const [lspSeverity, vscodeSeverity] of [[1, 0], [2, 1], [3, 2], [4, 3]]) {
    assert.equal(toVSCodeSeverity(lspSeverity), vscodeSeverity);
  }
  assert.equal(toVSCodeSeverity(undefined), 0);
});
