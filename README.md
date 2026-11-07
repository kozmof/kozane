# Kozane

Kozane is a tool for organizing text fragments and the relationships between them.

The name "Kozane" comes from こざね法 (kozane method), developed by Japanese anthropologist Tadao Umesao.

## Structures

Start by adding cards to a namespace. Use other structures only when you need them.

The names of these structures do not fix how you use them, so different projects can use them in different ways.

### Main

- Namespace: A top-level container. It contains partitions, which group text units called cards. Most operations take place within a namespace.
- Card: A unit of text.

### Others

- Partition: A sub-container assigned to each card. Every namespace has a default partition named "General".
- Layer: A group of cards with its own stacking order.
- Scope: A group of cards that can span namespaces and connect to taskspace directories. Add canvas frames to include overlapping cards. Scope names are unique across the workspace. A scope named `docs` is the same scope in every namespace.
- Warp: A saved point to jump to. Warps are not related to cards.
- Inventory: A grid that stores cards off the canvas. Drag cards in and out of it.

## Status

Kozane is beta software under active development and is not yet production-ready.

## Requirements

- Node.js 24 LTS

## Install

Install Kozane globally to use the `kozane` command from any directory.

```sh
npm install --global kozane
# or
pnpm add --global kozane
```

For a project-local installation, add Kozane as a development dependency and run it
with `npx`.

```sh
npm install --save-dev kozane
npx kozane init
npx kozane open
```

For a project-local installation with pnpm, use `pnpm exec`.

```sh
pnpm add --save-dev kozane
pnpm exec kozane init
pnpm exec kozane open
```

## Quick start

Initialize a workspace in a new directory, then launch the browser.

```sh
mkdir my-workspace && cd my-workspace
kozane init
kozane open
```

`kozane init` creates a default namespace named `main`. Commands use this namespace
when `--namespace` is omitted. Change it with `kozane namespace default <id>`.

Use `kozane open --memory` for a temporary database with a namespace named
`:memory:`. Workspace commands use that database while the server runs. All changes
are discarded when the server stops.

The `/health` endpoint checks server and database readiness. If the workspace has an API key, send it with monitoring probes. See [Production operations](./docs/production.md).

## UI

After `kozane open` launches the browser, choose a namespace from the landing page
to open its canvas.

### Creating and arranging cards

Type text in the composer at the bottom of the canvas and press `Enter` to create
a card. Double-click a card to edit it, and drag cards to arrange them.

See the [Browser UI handbook](./docs/browser-ui-handbook.md) for selection,
keyboard shortcuts, layers, scopes, and taskspaces.

### Browsing tags

The browser tag index is available at `/tags`. Add `?namespaceId=<id>` to limit it
to one namespace. It always includes taskspace files.

### Seeing across namespaces

The read-only map at `/map` shows namespaces, partitions, scopes, and tags across
the workspace.

A board shows the scopes and taskspaces associated with its namespace, along with
any that have not been assigned to a namespace.

### Remote login

For a browser on another device, open `https://your-proxy/`. Any unauthenticated
page load is redirected to a login page where you paste the key once. Kozane stores
it as an HttpOnly cookie and sends you back to where you were headed.
Opening `https://your-proxy/?api_key=<key>` skips the form. Kozane exchanges the
query parameter for the same cookie and removes it from the URL.

See [Security and remote access](#security-and-remote-access) for server setup and
API key generation.

## CLI

The [CLI specification](./spec/cli.md) covers every command, and the
[HTTP API specification](./spec/http.md) covers every endpoint the browser and API clients use.

### Adding cards from text

Pass the card text as a quoted argument to `card add`.

```sh
kozane card add "Investigate caching"
```

Use `card squash` to turn sentences into separate cards in a new inventory named
`Squash 1`, `Squash 2`, and so on. The default separator splits at a period followed
by whitespace, at `。`, or at a blank line. Periods inside URLs such as `example.com`
are preserved. Leading and trailing whitespace and empty segments are removed.

Pipe a file into the command.

```sh
cat foo.txt | kozane card squash
```

Set `--pattern` to a JavaScript regular expression source for a custom separator.

```sh
kozane card squash "one | two, three" --pattern '\s*[|,]\s*'
```

Choose where to put the new cards with namespace, partition, layer, and scope options.

```sh
cat foo.txt | kozane card squash --namespace eb155d6 --partition 72ac1f8 --scope e3ee90b
```

Every namespace starts with a `Base` layer. Add layers to organize cards.

```sh
kozane layer list
kozane layer add Draft
kozane card add --layer Draft "Only on the draft layer"
kozane card layer 3f9a2c1 Draft   # move a card you already wrote
kozane layer rename Draft Sketches
kozane layer move Sketches down
```

A layer can be named by its name, its ID, or a short ID. An exact name wins.

### Tagging

Add a tag to card text with a leading colon. Separate tag levels with more colons.

```sh
kozane card add "caching work :perf:cache"
```

Use `tag show perf` to find cards and files with `:perf` or its child tags, such as
`:perf:cache` and `:perf:cache:invalidation`.

```sh
kozane tag list          # every tag in the namespace, as a tree, with counts
kozane tag show perf     # the cards and files under it, subcategories included
```

A tag exists only while it appears in text, and only where a colon opens a word. It
has to sit at the start of a line, after whitespace, or after an opening bracket, so
ordinary punctuation like `3:45` or `key: value` is never mistaken for one.

To list cards alone, run `kozane tag show <tag> --no-files`.

### Seeing across namespaces

Inspect workspace-wide scopes and taskspaces with their list commands.

```sh
kozane scope list                    # every scope, and the namespaces each one reaches
kozane taskspace list                # every taskspace, with its namespace and scope
```

Pass `--namespace <id>` to either command to list the scopes or taskspaces visible
on that namespace's board.

### Security and remote access

Before starting a remote server, generate an API key for the workspace.

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote --no-open
```

The key is stored separately in `.kozane/api.json` with owner-only permissions. Once that file exists, every HTTP request requires the key. API clients send it as `Authorization: Bearer <key>` (preferred) or `X-API-Key: <key>`.
`kozane api key refresh` immediately replaces the old key.

API and `fetch` requests without valid credentials receive `401`. Browser requests can authenticate with the login cookie. For browser access, see [Remote login](#remote-login).

`--allow-remote` requires a generated key. Binding to a non-loopback address also requires `--no-open` and HTTPS. Remote plain HTTP requests are rejected. Terminate TLS at a reverse proxy, configure the trusted protocol header as described in [Production operations](./docs/production.md), and use firewall restrictions and an unprivileged runtime user.

For a full breakdown of what each run mode exposes, see the [Security matrix](./docs/security-matrix.md).

### Publishing a read-only static site

Use `net ssg generate` to build a read-only site from the workspace.

```sh
kozane net ssg generate --out ./site
```

Set `--base` to the URL path when hosting under a subdirectory such as
`https://[username].github.io/kozane/`.

```sh
kozane net ssg generate --out ./site --base /kozane
```

The output directory includes a `.nojekyll` file so GitHub Pages serves SvelteKit's `_app/` directory. Commit the directory to a branch and enable Pages for it. Static export requires the source build toolchain, so run it from a cloned repository after `pnpm install`.

The default export omits scopes and taskspaces. Add `--include-scoped-files` to
include scopes, taskspace names, and browsable copies of scoped taskspace files.

```sh
kozane net ssg generate --out ./site --include-scoped-files
```

This publishes real file contents from your local taskspace directories, so only use it on a workspace you're comfortable making public. Only taskspaces that belong to a scope are exported, because those are the ones a board draws. A taskspace outside every scope stays off the export entirely.

Each exported taskspace is capped at 20MB of embedded content and 50,000 entries. Files beyond the content cap, files over 16 MiB, and non-text files are still listed by name, but they open with an explanation instead of their contents. A directory past the entry cap, or nested more than 64 levels deep, is marked as not included. Dotfiles are never included, and symlinks are listed but never followed, the same as in the live file panel. No other files are skipped, so a taskspace pointed at a large checkout with `node_modules` will hit these limits.

Those caps are per taskspace per page, not per export. A taskspace you have not assigned to a namespace is drawn on every namespace's board, so its files are embedded in every namespace's page. Across five namespaces, a 20MB taskspace adds 100MB to the export. The directory is only walked once, but the bytes land once per page. Assign a taskspace to a namespace if you do not want it published board-wide.

Preview it over HTTP, not by opening the files directly.

```sh
kozane net ssg preview      # serves ./site at http://127.0.0.1:17174
```

The preview server resolves URLs the same way GitHub Pages does. Use `--out <dir>`
to serve a different directory. Set `--port` and `--host`, or `KOZANE_PREVIEW_PORT`
and `KOZANE_PREVIEW_HOST`, to change the address. Add `--no-open` to skip launching
a browser.

Preview a site built with `--base` using the same base path.

```sh
kozane net ssg preview --base /kozane
```

### Upgrades and recovery

Use the database commands to check status, migrate, export, or restore data.
Run `doctor` to inspect workspace problems.

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
For persisted-cache contents, refresh rules, and safe cleanup, see
[Cache behavior](./docs/cache.md).

## License

See [LICENCE](./LICENCE).

## Workspace packages

The repository root is a private tooling workspace. Published packages live in
`packages/core`, `packages/client` and `packages/kozane`. The CLI package remains unscoped
as `kozane`, with the same global installation and executable entry points.

Run `pnpm install`, `pnpm check`, `pnpm test` and `pnpm build` from the repository root.
The app source, configuration editor and CLI live in `packages/kozane/src`. App build
configuration and generated `build`, `build-ssg` and `dist` output belong to that package.
The original migration SQL stays under root `drizzle` and is copied unchanged into the
CLI artifact during builds.
