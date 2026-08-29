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

| Mode                                    | Network reach   | API key  | Transport       | Auth enforced          | Host checked       | Writes |
| --------------------------------------- | --------------- | -------- | --------------- | ---------------------- | ------------------ | ------ |
| Local                                   | Loopback only   | Optional | HTTP            | Only when a key exists | Only without a key | Yes    |
| Local with `--allow-remote`             | Loopback only   | Required | HTTP            | Yes                    | No                 | Yes    |
| Remote (`--allow-remote`, non-loopback) | Bound interface | Required | HTTPS via proxy | Yes                    | No                 | Yes    |
| Static export (SSG)                     | Wherever hosted | None     | Host-defined    | No server              | No server          | No     |

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

That URL becomes the browser launcher's command line, where other local users
can read it; `--no-open` and the login page avoid that.

### Host checking without a key

A keyless workspace checks the `Host` header and answers `403` to anything that
is not a loopback name. Without a key there is no credential to check, and a
hostname someone else controls can be pointed at `127.0.0.1` — DNS rebinding —
after which a page they serve is treated by the browser as this server's own
origin. `ORIGIN` does not settle that on its own: SvelteKit's cross-site check
covers form-shaped `POST`s, and reading the board is a `GET`.

To reach a keyless workspace under another name, such as a hosts-file alias or a
local proxy, list it in `KOZANE_ALLOWED_HOSTS` (comma-separated):

```sh
KOZANE_ALLOWED_HOSTS=kozane.local kozane open
```

Generating a key is the better answer. Once a workspace has one the check does
not apply, because the key is then the thing being verified — and the API-key
cookie belongs to the loopback origin, so a rebound page never receives it.

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

The export is public and read-only. It bakes out one page per project, each
carrying that project's cards, bundles, layers, warps, and glue, along with the
scopes that project draws. Anyone who can open the site reads all of it. There
is no API key, no login page, and no way to authenticate, because there is no
server. Composing, dragging, deleting, taskspaces, and live sync are all
disabled.

Every project in the workspace is exported, so narrowing scopes to a project
hides nothing here: a scope used by any project is on that project's page, and
one used by none is on every page. It is a question of which page a scope
appears on, not of whether it is published.

Do not export a workspace that holds anything you would not publish. Card text,
bundle names, scope names, layer names, and warp positions are all part of the
export by design, because that is what is being published.

Filesystem paths are not. The machine-specific workspace path is stripped, and
taskspace paths are redacted from the page data the export bakes in, so the
directories a workspace was worked in are not served to whoever opens the site.
By default taskspaces do not appear in a static export at all: a plain `kozane
net ssg generate` carries no scopes, no taskspace names, and no files.

`--include-scoped-files` is the exception, and it publishes real file contents:

```sh
kozane net ssg generate --out ./site --include-scoped-files
```

The export then carries the scopes each project draws, the names of the
taskspaces under those scopes, and a read-only copy of each of those taskspaces'
files, contents inline. A taskspace that belongs to no scope is not drawn by the
board, so it is left out of the export entirely — neither its name nor a byte of
it goes out. Everything else about the file boundary is the same as the live
server's, because the same code reads it: dot-entries are never included, so
`.git`, `.env`, and `.taskspace.json` stay out; symlinks are listed but never
followed; a file over 1 MB or one that is not valid UTF-8 is listed by name
with its contents withheld, as is a file past the 20 MB of content each taskspace
is exported within.

The other two ceilings drop what they stop at rather than naming it. Past 50,000
entries per taskspace, or more than 64 directories deep, the walk stops and marks
the directory it stopped in as truncated — so the enclosing directory is in the
export saying it is not all there, but the entries beyond the cut are not in it
at all, not even by name. Read an export as a floor on what went out, not a
census: what is there is there, and what a truncated directory was holding is
answered only by the working copy.

What that leaves is a judgment only you can make: these are your working
directories, published in full to whoever opens the site, with no key in front of
them. Use the flag only on a workspace whose taskspace files you would publish
deliberately.

## Taskspace files

The browser UI lists a taskspace directory, and opens and saves the text files in
it, so the server reads and writes the filesystem on behalf of whoever has the
page open. What that reaches is bounded.

Both the listing and the file endpoints are confined the same way. The directory
comes from the taskspace record and the workspace root; the request chooses only
where to look inside it. A path that walks out with `..` is refused, and so is
one that resolves out through a symlink — the boundary is checked twice, once on
the path as written and once on what it turned out to be with every link
followed. Dot-entries are refused outright, which keeps `.git`,
`.taskspace.json`, and a stray `.env` both out of the listing and beyond reach of
anyone who types the name. Both are gated like everything else: when a workspace
has an API key, a request without it gets 401.

**Listing** answers with entry names, kinds, sizes, and modification times, and
nothing else. Symlinks are listed but never followed.

**Reading** returns the text of one regular file. Symlinks, directories, and
anything that is not a regular file are refused, as is a file over 1 MB or one
that is not valid UTF-8.

**Scanning for tags** walks a taskspace and reads the text files in it, to gather
the tags written inside them for the tag index page and `kozane tag list|show`.
It reaches nothing a read does not: the walk is built on the same listing and
reading described here, so dot-entries are not scanned, symlinks are not
followed, and a file that is not UTF-8 text or is over 1 MB is passed over. What
it returns for each hit is a path, a line number, and that one line — not the
file. The walk is bounded by its own byte, entry, and depth budgets — per
taskspace, and again across a whole gather, so a workspace of many taskspaces
costs no more to read than a workspace of a few — and says when it stopped at
one. It also does not descend into generated or vendored
directories — `node_modules`, `build`, `dist`, `out`, `target`, `coverage`,
`vendor`, `bower_components`, `__pycache__` — which narrows what is read further
still, in the same direction as every other rule here.

What that scan gathered is kept in `.kozane/tag-index.json` so the next page load
does not repeat it, and the lines it quotes are kept with it. That is a file
inside the workspace holding excerpts of files that may sit outside it — a
taskspace created with `kozane taskspace create --dir <path>` can point anywhere
the server user can read. It is a cache and never a record: deleting it costs one
slow load, and it is rebuilt from the files themselves. Past 64 MB it is ignored
and rebuilt rather than read, since reading it happens while a page load waits.
Treat it as you would the taskspaces it summarizes, and keep it out of source
control if their contents should not be there either.

**Writing** replaces the contents of a file that is already there. It never
creates one, never writes outside the taskspace, and never writes a path
containing a dot-entry. The write is atomic — a temporary file, then a rename —
so a failure leaves the original intact rather than truncated. A save also
carries the file's identity as it was read, and is refused with 409 if the file
changed on disk since, so a save cannot silently discard someone else's edit.

Two consequences are worth stating plainly.

- A taskspace created outside the workspace root — `kozane taskspace create --dir
<path>` — is both readable and writable, because the boundary is the taskspace
  directory rather than the root. Point a taskspace at a directory only if you
  would let anyone who can reach the server read and rewrite the text files in
  it.
- On a local server with no API key, which is the state after a plain `kozane
init`, any local user or process that can reach the port can rewrite those
  files. That is the same trust boundary the database already sits behind, but
  it now extends to the working directory a taskspace points at. Generate a key
  with `kozane api key generate` if that is not what you want.

A static export has neither: no server to ask, and taskspace paths are stripped
from it. Nothing in an export can be written, and nothing can be read from it
that was not baked in at build time — by default no taskspace at all, and with
`--include-scoped-files` exactly the files described above.

The tag index page follows the same rule, and has to: a file hit carries a path
inside the workspace and a line of that file's content, and page data baked into
an export is readable by view-source however the page draws it. So a plain export
carries only the tags written on cards, and a tag written solely in a taskspace
file does not appear in it at all. With `--include-scoped-files`, file hits are
baked in alongside the files themselves.

The taskspaces themselves are named under the same flag and not otherwise. A
taskspace's name is the name of a directory on the machine the workspace was
built on, so an export that mentions no taskspace must not carry a list of them
either — the rule is the board's, and the tag index holds it because it publishes
the same kind of page.

## Where each rule lives

- Host and key checks at startup — `src/cli/commands/open.ts`
- Per-request key, TLS, redirect, and rate-limit gating — `src/hooks.server.ts`
- Loopback, TLS, and rate-limit helpers — `src/lib/server/security.ts`
- Login page and `next` guard — `src/routes/login/` and `src/lib/server/login.ts`
- Taskspace listing, read, and write boundary — `src/lib/server/taskspace-files.ts`
- Taskspace tag scan, on top of that boundary — `src/lib/server/taskspace-tags.ts`
- Atomic file replacement — `src/lib/server/atomic-write.ts`
