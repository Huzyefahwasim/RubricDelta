const CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|client[_-]?secret|private[_-]?key|password|auth[_-]?token)\s*[:=]\s*(?!process\.env\b)["']?[A-Za-z0-9._~+\/-]{12,}/i,
  /\bOPENAI_API_KEY\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
]);

const REDACTION_PATTERNS = Object.freeze(
  CREDENTIAL_PATTERNS.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`)),
);

export function containsCredentialLikeText(value) {
  const source = String(value);
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(source));
}

export function redactCredentialLikeText(value, replacement = "[REDACTED]") {
  let clean = String(value);
  for (const pattern of REDACTION_PATTERNS) clean = clean.replace(pattern, replacement);
  return clean;
}
