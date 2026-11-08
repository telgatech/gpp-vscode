function normalizeCompletionResult(result) {
  if (Array.isArray(result)) {
    return { items: result, isList: false, isIncomplete: false };
  }
  if (result && typeof result === "object" && Array.isArray(result.items)) {
    return { items: result.items, isList: true, isIncomplete: Boolean(result.isIncomplete) };
  }
  return { items: [], isList: false, isIncomplete: false };
}

module.exports = { normalizeCompletionResult };
