export const LOGIN_PATH = "/login";

// Allow post-login redirects only to same-origin paths other than the login page. Fall back
// to `/` for rejected values.
//
// Reject absolute URLs, protocol-relative URLs, backslashes, and control characters. Check
// the entire value because URL parsing removes tabs and newlines before resolving a path.
//
// oxlint-disable-next-line no-control-regex
const UNSAFE_NEXT_CHARS = /[\x00-\x1f\x7f\\]/;

export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || UNSAFE_NEXT_CHARS.test(next)) return "/";
  if (next === LOGIN_PATH || next.startsWith(LOGIN_PATH + "?")) return "/";
  return next;
}
