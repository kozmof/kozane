export const LOGIN_PATH = "/login";

// Only allow post-login redirects back to a same-origin path. Reject absolute
// URLs, protocol-relative ("//host") and backslash ("/\\host") forms that
// browsers resolve as off-origin, and the login page itself. Anything else
// collapses to "/". This is the open-redirect guard for the ?next= parameter.
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next === LOGIN_PATH || next.startsWith(LOGIN_PATH + "?")) return "/";
  return next;
}
