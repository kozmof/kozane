# Security matrix

Kozane runs in a few modes with different network exposure and authentication.
This page lists what each mode enforces so you can pick the right one and avoid
exposing a workspace by accident.

When a workspace has an API key, two rules hold in every server mode.

- The API-key cookie is `HttpOnly` and `SameSite=Strict`, so a cross-site page
  cannot read it or send it.
- Every mutating request needs the key, so an unauthenticated or cross-site
  request cannot change data.

## At a glance

| Mode                                    | Network reach   | API key  | Transport       | Auth enforced          | Writes |
| --------------------------------------- | --------------- | -------- | --------------- | ---------------------- | ------ |
| Local                                   | Loopback only   | Optional | HTTP            | Only when a key exists | Yes    |
| Local with `--allow-remote`             | Loopback only   | Required | HTTP            | Yes                    | Yes    |
| Remote (`--allow-remote`, non-loopback) | Bound interface | Required | HTTPS via proxy | Yes                    | Yes    |
| Static export (SSG)                     | Wherever hosted | None     | Host-defined    | No server              | No     |

## Local

```sh
kozane open
```

Binds to a loopback address (127.0.0.1 by default), so only the machine itself
can reach it. Served over plain HTTP.

An API key is optional in this mode.

- Without a key — no authentication. Any local user or process on the machine
  can read and write the workspace. This is the state after a plain
  `kozane init`.
- With a key (`kozane api key generate`) — every request needs the key.
  `kozane open` opens the browser with the key in the URL once, then swaps it
  for the cookie. A tab that arrives without the key is redirected to the login
  page, and an API or fetch client gets 401.

The cookie is not marked `Secure`, which is correct for loopback HTTP because
the traffic never leaves the host. `kozane open` sets the server `ORIGIN` to the
loopback URL so the login form passes SvelteKit's cross-site check.

## Local with `--allow-remote`

```sh
kozane open --allow-remote
```

Behaves like local with a key, with one addition. `--allow-remote` requires a
generated key and refuses to start without one, so authentication is always on.

The flag on its own does not expose the server. The host stays loopback unless
you also pass `--host`. To serve other machines, set a non-loopback host, which
moves you to the next mode.

## Remote

```sh
kozane open --host 0.0.0.0 --allow-remote --no-open
```

Binds to a non-loopback interface, so other machines can reach it. This is the
strictest mode.

- API key — required. The server refuses to start without one and answers 503
  until a key exists.
- HTTPS — required. Plain HTTP is rejected with 426. Terminate TLS at a reverse
  proxy and forward the scheme with `PROTOCOL_HEADER=x-forwarded-proto` so the
  server sees `https`.
- `--no-open` — required, because the browser must reach the HTTPS proxy URL,
  not the local HTTP listener.

Unauthenticated browser navigations are redirected to the login page over
HTTPS, API clients get 401, and repeated failures get 429. The cookie is marked
`Secure`. The origin for the cross-site check comes from the proxy headers you
configure, not from `kozane open`. See [Production operations](./production.md)
for the full proxy, firewall, and process-user guidance.

## Static export (SSG)

```sh
kozane net ssg generate
```

Builds plain HTML, CSS, and JS with no server, for hosting on GitHub Pages or
any static host.

The export is public and read-only. It carries a full snapshot of the database
at build time, so anyone who can open the site reads every card, bundle, scope,
and glue. There is no API key, no login page, and no way to authenticate,
because there is no server. Composing, dragging, deleting, taskspaces, and
live sync are all disabled.

Do not export a workspace that holds anything you would not publish. Card text,
bundle names, scope names, layer names, and warp positions are all part of the
export by design, because that is what is being published.

Filesystem paths are not. The machine-specific workspace path is stripped, and
taskspace paths are redacted from the page data the export bakes in, so the
directories a workspace was worked in are not served to whoever opens the site.
Taskspaces therefore do not appear in a static export at all.

## Where each rule lives

- Host and key checks at startup — `src/cli/commands/open.ts`
- Per-request key, TLS, redirect, and rate-limit gating — `src/hooks.server.ts`
- Loopback, TLS, and rate-limit helpers — `src/lib/server/security.ts`
- Login page and `next` guard — `src/routes/login/` and `src/lib/server/login.ts`
