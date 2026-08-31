const LOOPBACK_HOSTNAMES = Object.freeze(["127.0.0.1", "localhost", "::1"]);

const DEFAULT_SCHEME_PORTS = new Map([["http:", 80], ["https:", 443]]);

function normalizeHostname(value) {
  const lowered = value.toLowerCase();
  return lowered.startsWith("[") && lowered.endsWith("]") ? lowered.slice(1, -1) : lowered;
}

function isLoopbackHostname(value) {
  return LOOPBACK_HOSTNAMES.includes(value);
}

function headerCount(rawHeaders, name) {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === name) count += 1;
  }
  return count;
}

export function parseAuthority(rawValue) {
  if (typeof rawValue !== "string") return null;
  if (rawValue !== rawValue.trim() || rawValue === "" || /[\s,]/.test(rawValue)) return null;
  let hostname;
  let port = null;
  if (rawValue.startsWith("[")) {
    const end = rawValue.indexOf("]");
    if (end < 0) return null;
    hostname = rawValue.slice(1, end);
    const remainder = rawValue.slice(end + 1);
    if (remainder !== "") {
      if (!remainder.startsWith(":")) return null;
      port = remainder.slice(1);
    }
  } else {
    const parts = rawValue.split(":");
    if (parts.length > 2) return null;
    hostname = parts[0];
    if (parts.length === 2) port = parts[1];
  }
  if (hostname === "" || hostname.includes("@") || hostname.includes("/")) return null;
  if (port !== null && !/^[0-9]{1,5}$/.test(port)) return null;
  return { hostname: normalizeHostname(hostname), port: port === null ? 80 : Number(port) };
}

export function parseHttpOrigin(rawValue) {
  if (typeof rawValue !== "string" || rawValue !== rawValue.trim() || rawValue === "") return null;
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    return null;
  }
  if (url.origin !== rawValue) return null;
  if (!DEFAULT_SCHEME_PORTS.has(url.protocol)) return null;
  if (url.username !== "" || url.password !== "") return null;
  const port = url.port === "" ? DEFAULT_SCHEME_PORTS.get(url.protocol) : Number(url.port);
  return { protocol: url.protocol, hostname: normalizeHostname(url.hostname), port };
}

function denial(status, code, message) {
  return { allowed: false, status, body: { error: { code, message } } };
}

const ALLOWED = Object.freeze({ allowed: true });

export function evaluateRequestAuthority({ headers = {}, rawHeaders = [], boundPort }) {
  if (!Number.isInteger(boundPort)) {
    return denial(403, "FORBIDDEN_HOST", "The server cannot resolve its bound loopback port");
  }
  if (headerCount(rawHeaders, "host") > 1) {
    return denial(400, "INVALID_HOST", "Exactly one Host header is required");
  }
  const authority = parseAuthority(headers.host);
  if (authority === null) {
    return denial(400, "INVALID_HOST", "A single well-formed Host header is required");
  }
  if (!isLoopbackHostname(authority.hostname) || authority.port !== boundPort) {
    return denial(403, "FORBIDDEN_HOST", "This loopback server accepts only its own bound loopback host and port");
  }
  if (headerCount(rawHeaders, "origin") > 1) {
    return denial(403, "FORBIDDEN_ORIGIN", "Exactly one Origin header is allowed");
  }
  if (headers.origin === undefined) return ALLOWED;
  const origin = parseHttpOrigin(headers.origin);
  if (origin === null || origin.protocol !== "http:" || !isLoopbackHostname(origin.hostname) || origin.port !== boundPort) {
    return denial(403, "FORBIDDEN_ORIGIN", "This loopback server accepts only its own bound loopback origin");
  }
  return ALLOWED;
}
