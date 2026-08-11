# Kozane

> ⚠️ Status: Beta — Kozane is under active development and not yet production-ready. Expect breaking changes to commands and data formats, and avoid using it for irreplaceable data.

Kozane is a local-first, short text alignment workspace. It builds on the kozane method (こざね法), a way of organizing ideas on small cards developed by the Japanese anthropologist Tadao Umesao.

## Requirements

- Node.js 24 LTS

## Install

Install Kozane globally to make the `kozane` command available everywhere with npm or pnpm:

```sh
npm install --global kozane
# or
pnpm add --global kozane
```

Or install it as a development dependency to keep the `kozane` command scoped to the
project:

```sh
npm install --save-dev kozane
npx kozane init
npx kozane open
```

With pnpm:

```sh
pnpm add --save-dev kozane
pnpm exec kozane init
pnpm exec kozane open
```

## Quick start

Create a workspace and open it:

```sh
mkdir my-workspace && cd my-workspace
kozane init
kozane open
```

For working in the browser UI, see the
[Browser UI handbook](./docs/browser-ui-handbook.md). On a board wider than the
screen, press `a` to drop a warp under the pointer and use the arrow keys to
move between warps, wrapping round at the edges. `Shift` with an arrow key lists
every warp in the workspace, so one jump reaches another project's board.

To start with an empty database that exists only for the lifetime of the server,
use `kozane open --memory`. It creates a project named `:memory:`, and all
changes are discarded when the server stops. `kozane init` creates a default project named
`main`; use `kozane project default <id>` to change which project commands use when
`--project` is omitted.

The server defaults to `127.0.0.1:17173` — a port chosen to stay out of the way of the
defaults other dev servers take (Vite's 5173, `3000`, `8080`, and so on). Change it with
`--host` / `--port`, with the `KOZANE_HOST` / `KOZANE_PORT` environment variables, or by
editing `server` in `.kozane/config.json`; the flag wins over the environment, which wins
over the config file.

The `/health` endpoint checks server and database readiness and reports process CPU
capacity and system memory usage as percentages on a 0–100 scale.

## Adding cards from text

Create one card from a quoted argument:

```sh
kozane card add "Investigate caching"
```

To turn sentences into separate cards, use `card squash`. By default it splits on
`. ` (a period followed by a space), `。`, and blank lines, so dots inside URLs
such as `example.com` are preserved. It trims whitespace and ignores empty segments:

```sh
cat foo.txt | kozane card squash
```

Pass a JavaScript regular expression source to customize the separator:

```sh
kozane card squash "one | two, three" --pattern '\s*[|,]\s*'
```

Project, bundle, layer, and scope options also work with piped files:

```sh
cat foo.txt | kozane card squash --project eb155d6 --bundle 72ac1f8 --scope e3ee90b
```

A layer is a surface cards sit on, so a set of cards can be worked on with the
rest of the board dimmed behind it. Every project starts with a `Base` layer:

```sh
kozane layer list
kozane layer add Draft
kozane card add --layer Draft "Only on the draft layer"
kozane card layer 3f9a2c1 Draft   # move a card you already wrote
kozane layer rename Draft Sketches
kozane layer move Sketches down
```

A layer can be named by its name, its ID, or a short ID; an exact name wins.

## Security and remote access

Generate a per-workspace API key before allowing remote access:

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote --no-open
```

The key is stored separately in `.kozane/api.json` with owner-only permissions. Once that file exists, every HTTP request requires the key. API clients can send `Authorization: Bearer <key>` (preferred) or `X-API-Key: <key>`. `kozane api key refresh` immediately replaces the old key.

For a browser on another device, just open `https://your-proxy/`. Any unauthenticated page load is redirected to a login page where you paste the key once. Kozane stores it as an HttpOnly cookie and sends you back to where you were headed. You can still open `https://your-proxy/?api_key=<key>` to skip the form, and Kozane exchanges the query parameter for the same cookie and removes it from the URL. API and `fetch` clients are unaffected. An unauthenticated request without a valid `Authorization: Bearer` (or `X-API-Key`) still receives a `401`, not the login page.

`--allow-remote` always requires a generated key, `--no-open`, and HTTPS. Plain HTTP requests are rejected. Terminate TLS at a reverse proxy, configure the trusted protocol header as described below, and use firewall restrictions and an unprivileged runtime user.

For a full breakdown of what each run mode exposes, see the [Security matrix](./docs/security-matrix.md).

## Publishing a read-only static site

Export the current workspace as a static site:

```sh
kozane net ssg generate --out ./site
```

When hosting under a subdirectory, such as `https://[username].github.io/kozane/`, pass
the base path:

```sh
kozane net ssg generate --out ./site --base /kozane
```

The output directory includes a `.nojekyll` file so GitHub Pages serves
SvelteKit's `_app/` directory. Commit the directory to a branch and enable Pages
for it. Static export requires the source build toolchain, so run it from a
cloned repository after `pnpm install`.

Preview it over HTTP, not by opening the files directly.

```sh
kozane net ssg preview      # serves ./site at http://127.0.0.1:17174
```

`kozane net ssg preview` resolves URLs the same way GitHub Pages does, so it matches
what you get once deployed. Use `--out <dir>` to serve a different directory,
`--port` and `--host` (or `KOZANE_PREVIEW_PORT` / `KOZANE_PREVIEW_HOST`) to change
the address, and `--no-open` to skip launching a browser. If the site was built with `--base`, preview it with the same base:

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
kozane doctor config
```

Migrations create a backup first. Back up the entire `.kozane` directory and test restores regularly.
After hand-editing `.kozane/config.json`, `kozane doctor config` lists every missing key,
unknown key, and invalid value in one pass.

## Development and releases

Building Kozane itself from source requires pnpm 10.17.0:

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
