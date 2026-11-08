const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeCompletionResult } = require("../lsp_completion");

test("accepts completion item arrays", () => {
  const items = [{ label: "alpha" }];
  assert.deepEqual(normalizeCompletionResult(items), {
    items,
    isList: false,
    isIncomplete: false
  });
});

test("preserves CompletionList items and incompleteness", () => {
  const items = [{ label: "alpha" }];
  assert.deepEqual(normalizeCompletionResult({ items, isIncomplete: true }), {
    items,
    isList: true,
    isIncomplete: true
  });
});

test("handles null and invalid completion results", () => {
  assert.deepEqual(normalizeCompletionResult(null), {
    items: [],
    isList: false,
    isIncomplete: false
  });
  assert.deepEqual(normalizeCompletionResult({ items: "invalid" }), {
    items: [],
    isList: false,
    isIncomplete: false
  });
});
