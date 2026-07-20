const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;

type FailureWindow = { count: number; resetAt: number };
const authFailures = new Map<string, FailureWindow>();

export function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) return value.split("]", 1)[0] + "]";
  return value.split(":", 1)[0];
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

export function remoteBindingRequiresApiKey(host = process.env.HOST ?? "127.0.0.1"): boolean {
  return !isLoopbackHost(host);
}

export function recordAuthFailure(client: string, now = Date.now()): number | null {
  const current = authFailures.get(client);
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

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  );
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
