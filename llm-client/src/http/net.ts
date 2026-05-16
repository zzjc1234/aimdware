/**
 * Resolve the outbound proxy URL (if any) for a given target URL, honoring
 * HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY environment variables.
 *
 * Precedence:
 *   1. Localhost / loopback (`localhost`, `127.0.0.1`, `::1`) -> never proxied.
 *   2. NO_PROXY entries -> never proxied (exact host, `.suffix`, or `*`).
 *   3. Scheme-specific (HTTPS_PROXY for https://, HTTP_PROXY for http://).
 *   4. ALL_PROXY as fallback.
 *
 * Uppercase env vars beat lowercase if both are set.
 */
export function getProxyForUrl(url: string | URL): string | undefined {
  const u = typeof url === "string" ? new URL(url) : url;
  const host = stripIpv6Brackets(u.hostname.toLowerCase());

  if (isLoopback(host)) return undefined;

  const noProxy = readEnv("NO_PROXY", "no_proxy");
  if (noProxy && matchesNoProxy(host, noProxy)) return undefined;

  if (u.protocol === "https:") {
    const p = readEnv("HTTPS_PROXY", "https_proxy");
    if (p) return p;
  } else if (u.protocol === "http:") {
    const p = readEnv("HTTP_PROXY", "http_proxy");
    if (p) return p;
  }

  return readEnv("ALL_PROXY", "all_proxy");
}

function readEnv(upper: string, lower: string): string | undefined {
  const v = process.env[upper] ?? process.env[lower];
  return v && v.length > 0 ? v : undefined;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function matchesNoProxy(host: string, noProxy: string): boolean {
  const entries = noProxy
    .split(",")
    .map((s) => normalizeNoProxyEntry(s.trim().toLowerCase()))
    .filter(Boolean);
  for (const entry of entries) {
    if (entry === "*") return true;
    if (entry.startsWith(".")) {
      // ".example.com" matches "sub.example.com" and "example.com"
      const suffix = entry.slice(1);
      if (host === suffix || host.endsWith(entry)) return true;
    } else if (host === entry || host.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

function normalizeNoProxyEntry(entry: string): string {
  if (entry.startsWith("[") && entry.includes("]")) {
    return entry.slice(1, entry.indexOf("]"));
  }
  return entry.replace(/:\d+$/, "");
}
