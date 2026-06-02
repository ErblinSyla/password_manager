import { getDomain } from "tldts";

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function extractHostname(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  let hostname = trimmed;

  if (URL_SCHEME_RE.test(trimmed)) {
    try {
      hostname = new URL(trimmed).hostname;
    } catch {
      // fall through: treat as hostname
    }
  }

  hostname = hostname.toLowerCase();
  if (hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }

  return hostname || null;
}

/**
 * Normalizes a hostname-like string to an eTLD+1 “registrable domain” when possible.
 *
 * Examples:
 * - login.foo.co.uk -> foo.co.uk
 * - foo.github.io (private suffix) -> foo.github.io
 * - localhost -> localhost
 * - 127.0.0.1 -> 127.0.0.1
 */
export function normalizeDomain(input: unknown): string | null {
  const hostname = extractHostname(input);
  if (!hostname) return null;

  if (hostname === "localhost") {
    return hostname;
  }

  const registrable = getDomain(hostname, { allowPrivateDomains: true });
  return registrable || hostname;
}
