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
  while (authFailures.size >= AUTH_FAILURE_MAX_CLIENTS) {
    const oldest = authFailures.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    authFailures.delete(oldest);
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
  if (!current || current.resetAt <= now) pruneAuthFailures(now);
  const window =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + AUTH_FAILURE_WINDOW_MS }
      : current;
  window.count += 1;
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

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
