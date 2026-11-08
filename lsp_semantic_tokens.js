function decodeSemanticTokens(result, tokenTypeCount) {
  const data = Array.isArray(result?.data) ? result.data : [];
  const tokens = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index];
    const deltaCharacter = data[index + 1];
    const length = data[index + 2];
    const tokenType = data[index + 3];
    const tokenModifiers = data[index + 4];
    if (![deltaLine, deltaCharacter, length, tokenType, tokenModifiers].every(Number.isInteger)) continue;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;
    if (line < 0 || character < 0 || length <= 0 || tokenType < 0 || tokenType >= tokenTypeCount || tokenModifiers < 0) continue;
    tokens.push({ line, character, length, tokenType, tokenModifiers });
  }
  return tokens;
}

module.exports = { decodeSemanticTokens };
