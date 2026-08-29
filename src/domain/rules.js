import { normalizeTokens, splitWithSpans } from "./text.js";

export class EvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceError";
  }
}

export function citationFor(document, span) {
  if (typeof document?.version !== "string" || document.version.trim() === "") {
    throw new EvidenceError("A guideline version is required to create evidence citations");
  }
  return { documentId: document.version, section: `sentence-${span.index + 1}`, start: span.start, end: span.end, quote: document.text.slice(span.start, span.end) };
}

function targetAndException(raw) {
  const match = raw.match(/^(.*?)(?:\s+(even when|unless|along with)\s+(.+))?$/i);
  return { label: match[1].trim(), exception: match[3]?.trim() ?? "" };
}

export function extractRoutingRules(document) {
  if (!document || typeof document.text !== "string") throw new EvidenceError("A guideline with text is required");
  const rules = [];
  for (const span of splitWithSpans(document.text)) {
    const route = span.text.match(/^Route\s+(.+)\s+to\s+(.+?)[.!?]?$/i);
    if (!route) continue;
    const parsed = targetAndException(route[2]);
    if (!parsed.label) continue;
    rules.push({
      id: `${document.version}-r${rules.length + 1}`,
      label: parsed.label,
      conditions: normalizeTokens(route[1]),
      exceptions: normalizeTokens(parsed.exception),
      precedence: /\b(even when|unless|takes precedence|overrides?)\b/i.test(span.text),
      citation: citationFor(document, span),
    });
  }
  return rules;
}
