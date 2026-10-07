const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
export const AUTH_FAILURE_MAX_CLIENTS = 10_000;

type FailureWindow = { count: number; resetAt: number };
const authFailures = new Map<string, FailureWindow>();

function pruneAuthFailures(now: number): void {
  for (const [client, window] of authFailures) {
    if (window.resetAt <= now) authFailures.delete(client);
  }
  // Iteration order is least-recently-active first (see recordAuthFailure), so this
  // evicts idle clients and leaves the active ones counted.
  while (authFailures.size >= AUTH_FAILURE_MAX_CLIENTS) {
    const idlest = authFailures.keys().next().value as string | undefined;
    if (idlest === undefined) break;
    authFailures.delete(idlest);
  }
}

export function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    return closingBracket === -1 ? value : value.slice(1, closingBracket);
  }
  // An unbracketed value containing multiple colons is an IPv6 address, not a
  // hostname followed by a port. In particular, splitting "::1" on the first
  // colon would turn the IPv6 loopback address into an empty string.
  if (value.indexOf(":") !== value.lastIndexOf(":")) return value;
  return value.split(":", 1)[0];
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

export function remoteBindingRequiresApiKey(host = process.env.HOST ?? "127.0.0.1"): boolean {
  return !isLoopbackHost(host);
}

export function remoteBindingRequiresTls(
  protocol: string,
  host = process.env.HOST ?? "127.0.0.1",
): boolean {
  return !isLoopbackHost(host) && protocol !== "https:";
}

/**
 * Validate Host for a keyless loopback workspace to prevent DNS rebinding from reading it
 * under an arbitrary hostname. CSRF origin checks do not protect ordinary GET requests.
 *
 * Allow explicit aliases through comma-separated `KOZANE_ALLOWED_HOSTS`. Key-protected
 * workspaces use authentication instead of this gate.
 */
export function isAllowedRequestHost(
  host: string,
  allowList = process.env.KOZANE_ALLOWED_HOSTS,
): boolean {
  if (isLoopbackHost(host)) return true;
  const normalized = normalizeHost(host);
  // An empty entry would otherwise match a request that named no host at all.
  return (allowList ?? "")
    .split(",")
    .map((entry) => normalizeHost(entry))
    .filter((entry) => entry !== "")
    .includes(normalized);
}

/** An `http:` loopback origin, parsed, or null for anything else. */
function parseLoopbackOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  return isLoopbackHost(url.hostname) ? url : null;
}

/**
 * Normalize loopback form origins to the Node adapter's configured origin. Local port
 * forwarding may expose localhost:5174 while the server binds 127.0.0.1:5173.
 *
 * For different ports, require Origin to match the request's Host exactly. Browsers cannot
 * choose Host independently of the request URL. Do not trust forwarded headers. Allow
 * same-port loopback aliases and leave missing or non-loopback origins to SvelteKit's CSRF
 * check.
 */
export function canonicalLoopbackOrigin(
  requestOrigin: string | undefined,
  pinnedOrigin: string | undefined,
  requestHost?: string,
): string | null {
  if (!requestOrigin || !pinnedOrigin) return null;
  const pinned = parseLoopbackOrigin(pinnedOrigin);
  const incoming = parseLoopbackOrigin(requestOrigin);
  if (!pinned || !incoming) return null;
  if (pinned.port !== incoming.port && requestHost !== incoming.host) return null;
  return incoming.origin === pinned.origin ? null : pinned.origin;
}

/**
 * Explain when remote clients may share one authentication throttle counter. Behind a proxy,
 * configure `ADDRESS_HEADER` so `getClientAddress()` identifies each client.
 *
 * Report this as a startup warning rather than refusing to serve. Exempt loopback bindings.
 */
export function remoteThrottleWarning(
  host = process.env.HOST ?? "127.0.0.1",
  addressHeader = process.env.ADDRESS_HEADER,
): string | null {
  if (isLoopbackHost(host)) return null;
  if (addressHeader?.trim()) return null;
  return (
    "Bound remotely with no ADDRESS_HEADER set. Every request will be counted against the " +
    "proxy's own address, so one client failing to authenticate throttles all of them. Set " +
    "ADDRESS_HEADER (typically x-forwarded-for) and XFF_DEPTH for your proxy chain — see " +
    "docs/production.md."
  );
}

export function recordAuthFailure(client: string, now = Date.now()): number | null {
  const current = authFailures.get(client);
  const rolledOver = !current || current.resetAt <= now;
  // Sweeping on roll-over alone lets a single client hammering one address keep the
  // map from ever reclaiming expired entries, so sweep at capacity as well.
  if (rolledOver || authFailures.size >= AUTH_FAILURE_MAX_CLIENTS) pruneAuthFailures(now);

  const window: FailureWindow =
    current && !rolledOver ? current : { count: 0, resetAt: now + AUTH_FAILURE_WINDOW_MS };
  window.count += 1;
  // Reinsert the key to update its position. Overwriting preserves insertion order and would
  // evict busy clients before idle ones.
  authFailures.delete(client);
  authFailures.set(client, window);

  return window.count > AUTH_FAILURE_LIMIT
    ? Math.max(1, Math.ceil((window.resetAt - now) / 1000))
    : null;
}

export function clearAuthFailures(client: string): void {
  authFailures.delete(client);
}

export function _resetAuthFailuresForTest(): void {
  authFailures.clear();
}

// Identify browser navigation through `Sec-Fetch-Mode`, falling back to GET requests
// accepting HTML. Redirect those requests to login and preserve 401 responses for API
// clients.
export function isBrowserNavigation(request: Request): boolean {
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  if (request.method !== "GET") return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Fallback content security policy for plain-text and empty responses built outside SvelteKit
 * rendering. Apply it only when no CSP header is present so rendered pages keep their
 * generated policy.
 */
const FALLBACK_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (!headers.has("content-security-policy")) headers.set("content-security-policy", FALLBACK_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
