const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeSemanticTokens } = require("../lsp_semantic_tokens");

test("decodes LSP relative tokens into numeric VS Code builder arguments", () => {
  const tokens = decodeSemanticTokens({ data: [0, 2, 4, 8, 3, 1, 0, 5, 11, 1] }, 21);
  assert.deepEqual(tokens, [
    { line: 0, character: 2, length: 4, tokenType: 8, tokenModifiers: 3 },
    { line: 1, character: 0, length: 5, tokenType: 11, tokenModifiers: 1 }
  ]);
  assert.equal(typeof tokens[0].tokenType, "number");
  assert.equal(typeof tokens[0].tokenModifiers, "number");
});

test("skips invalid semantic tokens without breaking later relative positions", () => {
  const tokens = decodeSemanticTokens({ data: [0, 0, 0, 2, 0, 0, 3, 2, 2, 0, 0, 1, 2, 99, 0] }, 21);
  assert.deepEqual(tokens, [
    { line: 0, character: 3, length: 2, tokenType: 2, tokenModifiers: 0 }
  ]);
});
