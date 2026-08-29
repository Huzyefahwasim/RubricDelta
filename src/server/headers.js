export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

export function responseHeaders(contentType) {
  return contentType
    ? { ...SECURITY_HEADERS, "Content-Type": contentType }
    : { ...SECURITY_HEADERS };
}
