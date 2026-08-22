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

export function recordAuthFailure(client: string, now = Date.now()): number | null {
  const current = authFailures.get(client);
  const rolledOver = !current || current.resetAt <= now;
  // Sweeping on roll-over alone lets a single client hammering one address keep the
  // map from ever reclaiming expired entries, so sweep at capacity as well.
  if (rolledOver || authFailures.size >= AUTH_FAILURE_MAX_CLIENTS) pruneAuthFailures(now);

  const window: FailureWindow =
    current && !rolledOver ? current : { count: 0, resetAt: now + AUTH_FAILURE_WINDOW_MS };
  window.count += 1;
  // Re-insert rather than overwrite: `set` on an existing key keeps its original
  // position, which would order the map by first-seen and make eviction discard the
  // busiest clients instead of the idlest ones.
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

// A top-level browser navigation, as opposed to an API call or a fetch/XHR
// from page code. Browsers set `Sec-Fetch-Mode: navigate` on document loads;
// for clients that omit it we fall back to a GET that accepts HTML. Only these
// get redirected to the login page — everything else keeps a 401.
export function isBrowserNavigation(request: Request): boolean {
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  if (request.method !== "GET") return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * The policy for a response Kozane built by hand rather than one SvelteKit rendered — the
 * two 503s, the 426, the 401, the 429, the login redirect.
 *
 * Pages already carry a policy and a stricter one: `kit.csp` in `svelte.config.js` is
 * applied while the page is rendered, with nonces for the scripts SvelteKit inlines. This
 * is only for the responses that never reach that code, which would otherwise name no
 * policy at all. They are plain text or empty, so `none` across the board costs them
 * nothing.
 *
 * Set rather than overwritten only when absent, so a rendered page keeps the policy that
 * was built for it. (The prerendered export carries its policy in a `<meta>` tag instead,
 * which this could not see — but that path returns before `applySecurityHeaders` is
 * reached, so the question does not arise.)
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
