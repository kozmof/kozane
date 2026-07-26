# Kozane

> ⚠️ Status: Beta — Kozane is under active development and not yet production-ready. Expect breaking changes to commands and data formats, and avoid using it for irreplaceable data.

Kozane is a local-first, card-based thinking workspace with a browser UI, CLI, and a per-workspace SQLite-compatible database.

It builds on the kozane method (こざね法), a way of organizing ideas on small cards developed by the Japanese anthropologist Tadao Umesao.

## Requirements

- Node.js 22 or 24 LTS
- pnpm 10.12.1 for source builds

## Quick start

Kozane is not published to npm yet. Clone the repository, then build and link it:

```sh
git clone https://github.com/kozmof/kozane.git
cd kozane
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
```

Then create a workspace and open it:

```sh
mkdir my-workspace && cd my-workspace
kozane init
kozane open
```

To start with an empty database that exists only for the lifetime of the server,
use `kozane open --memory`. It creates a project named `:memory:`, and all
changes are discarded when the server stops. `kozane init` creates a default project named
`main`; use `kozane project default <id>` to change which project commands use when
`--project` is omitted.

The server defaults to `127.0.0.1:5173`. The `/health` endpoint checks server and database
readiness and reports process CPU capacity and system memory usage as percentages on a 0–100 scale.

## Adding cards from text

Create one card from a quoted argument:

```sh
kozane card add "Investigate caching"
```

To turn sentences into separate cards, use `card squash`. It splits on both `.` and
`。`, trims whitespace, and ignores empty segments:

```sh
cat foo.txt | kozane card squash
```

Project, bundle, and scope options also work with piped files:

```sh
cat foo.txt | kozane card squash --project eb15 --bundle 72ac --scope e3ee
```

## Security and remote access

Generate a per-workspace API key before allowing remote access:

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote --no-open
```

The key is stored separately in `.kozane/api.json` with owner-only permissions. Once that file exists, every HTTP request requires the key. API clients can send `Authorization: Bearer <key>` (preferred) or `X-API-Key: <key>`. `kozane api key refresh` immediately replaces the old key.

For a browser on another device, just open `https://your-proxy/`. Any unauthenticated page load is redirected to a login page where you paste the key once; Kozane stores it as an HttpOnly cookie and sends you back to where you were headed. You can still open `https://your-proxy/?api_key=<key>` to skip the form — Kozane exchanges the query parameter for the same cookie and removes it from the URL. API and `fetch` clients are unaffected: an unauthenticated request without a valid `Authorization: Bearer` (or `X-API-Key`) still receives a `401`, not the login page.

`--allow-remote` always requires a generated key, `--no-open`, and HTTPS. Plain HTTP requests are rejected. Terminate TLS at a reverse proxy, configure the trusted protocol header as described below, and use firewall restrictions and an unprivileged runtime user.

## Publishing a read-only static site

Export the current workspace as a static site — plain HTML, CSS, and JS with no
server — suitable for GitHub Pages or any static host:

```sh
kozane net ssg generate --out ./site
```

The export is a snapshot of the database at build time. Cards, bundles, scopes,
and glues render and you can pan, zoom, and filter, but everything that writes
(composing, dragging, deleting, working copies) and the live-sync poll are
disabled — there is no server to talk to. Re-run `kozane net ssg generate` to
refresh the snapshot.

When hosting under a subdirectory, such as `https://[username].github.io/kozane/`, pass
the base path:

```sh
kozane net ssg generate --out ./site --base /kozane
```

The output directory includes a `.nojekyll` file so GitHub Pages serves
SvelteKit's `_app/` directory. Commit the directory to a branch and enable Pages
for it. Static export requires the source build toolchain, so run it from a
cloned repository after `pnpm install`.

Preview it over HTTP, not by opening the files directly — `file://` shows a
directory listing instead of the page and blocks the scripts the app needs to
become interactive:

```sh
kozane net ssg preview      # serves ./site at http://127.0.0.1:4173
```

`kozane net ssg preview` resolves URLs the same way GitHub Pages does, so it matches
what you get once deployed. Use `--out <dir>` to serve a different directory,
`--port` and `--host` to change the address, and `--no-open` to skip launching a
browser. If the site was built with `--base`, preview it with the same base:

```sh
kozane net ssg preview --base /kozane
```

## Upgrades and recovery

```sh
kozane db status
kozane db migrate
kozane db export
kozane db restore
kozane doctor
```

Migrations create a backup first. Back up the entire `.kozane` directory and test restores regularly.

## Development and releases

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm audit:production
pnpm smoke:package
pnpm test:e2e
```

`pnpm verify` runs static checks, formatting, coverage thresholds, tests, and a clean production build. `pnpm verify:production` runs the complete local release gate, including the dependency audit, installed-package smoke test, and real-browser workflow test. CI verifies the current Node 24 LTS and latest release lines, packages the result, runs a deployed-workflow smoke test, and exercises the built application in Chromium. Package builds clean `build/` and `dist/` first to prevent stale artifacts.

For TLS, process supervision, monitoring, backup, restore, and release-gate guidance, see
[Production operations](./docs/production.md).

## License

See [LICENCE](./LICENCE).
