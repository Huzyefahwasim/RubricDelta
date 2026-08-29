const STOP_WORDS = new Set(["a", "all", "an", "and", "are", "as", "at", "by", "for", "from", "if", "in", "is", "of", "on", "or", "that", "the", "this", "to", "when", "with"]);

export function normalizeTokens(text) {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .map((token) => token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token)
    .filter((token) => !STOP_WORDS.has(token)))].sort();
}

export function splitWithSpans(text) {
  const spans = [];
  const sentence = /[^.!?]+[.!?]?/g;
  for (const match of text.matchAll(sentence)) {
    const raw = match[0];
    const leading = raw.match(/^\s*/)[0].length;
    const value = raw.trim();
    if (!value) continue;
    const start = match.index + leading;
    spans.push({ index: spans.length, text: value, start, end: start + value.length, tokens: normalizeTokens(value) });
  }
  return spans;
}
