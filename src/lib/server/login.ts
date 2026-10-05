export const LOGIN_PATH = "/login";

// Only allow post-login redirects back to a same-origin path. Reject absolute
// URLs, protocol-relative ("//host") and backslash ("/\\host") forms that
// browsers resolve as off-origin, and the login page itself. Anything else
// collapses to "/". This is the open-redirect guard for the ?next= parameter.
//
// Control characters and backslashes are refused anywhere in the value, not only right
// after the leading slash: the URL parser strips tab and newline before resolving, so
// "/\t/host" reaches the browser as "//host".
// oxlint-disable-next-line no-control-regex
const UNSAFE_NEXT_CHARS = /[\x00-\x1f\x7f\\]/;

export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || UNSAFE_NEXT_CHARS.test(next)) return "/";
  if (next === LOGIN_PATH || next.startsWith(LOGIN_PATH + "?")) return "/";
  return next;
}
