# Kozane

Kozane provides data structures for organizing text.
The names of these structures do not fix how you use them, so different projects can
use them in different ways.

The name "Kozane" comes from こざね法 (kozane method), developed by Japanese anthropologist Tadao Umesao.

## Structures

- Namespace: A top-level container. It contains partitions, which group text units called cards. Most operations take place within a namespace.
- Partition: A sub-container assigned to each card. Every namespace has a default partition named "General."
- Card: A unit of text.
- Layer: A way to arrange cards in layers.
- Scope: A link between cards and taskspaces. Taskspaces correspond to directories and files on the filesystem. A scope can also be given a frame on a canvas, in which case the cards overlapping the frame belong to it. A scope belongs to the workspace rather than to one namespace, so its name is unique across the whole workspace. A scope named `docs` in one namespace is the same scope in every other namespace that uses that name.
- Warp: A saved point to jump to. Warps are not related to cards.

## Status

Kozane is beta software under active development and is not yet production-ready.

## Requirements

- Node.js 24 LTS

## Install

Install Kozane globally with npm or pnpm to make the `kozane` command available everywhere:

```sh
npm install --global kozane
# or
pnpm add --global kozane
```

Or install it as a development dependency to keep the `kozane` command scoped to the project:

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

To start with an empty database that exists only for the lifetime of the server, use `kozane open --memory`. It creates a namespace named `:memory:`, and all changes are discarded when the server stops. `kozane init` creates a default namespace named `main`. Run `kozane namespace default <id>` to change which namespace commands use when `--namespace` is omitted.

The `/health` endpoint checks server and database readiness. It sits behind the same authentication as everything else, so once the workspace has an API key, a monitoring probe has to send it too. See [Production operations](./docs/production.md).

For working in the browser UI, see the [Browser UI handbook](./docs/browser-ui-handbook.md).
The [CLI specification](./spec/cli.md) covers every command, and the
[HTTP API specification](./spec/http.md) covers every endpoint the browser and API clients use.

## Adding cards from text

Create one card from a quoted argument:

```sh
kozane card add "Investigate caching"
```

To turn sentences into separate cards, use `card squash`. By default it splits on a period followed by whitespace (a space or a line break), on `。`, and on blank lines, so dots inside URLs such as `example.com` are preserved. It trims whitespace and ignores empty segments:

```sh
cat foo.txt | kozane card squash
```

Pass a JavaScript regular expression source to customize the separator:

```sh
kozane card squash "one | two, three" --pattern '\s*[|,]\s*'
```

Namespace, partition, layer, and scope options also work with piped files:

```sh
cat foo.txt | kozane card squash --namespace eb155d6 --partition 72ac1f8 --scope e3ee90b
```

Every namespace starts with a `Base` layer. For example:

```sh
kozane layer list
kozane layer add Draft
kozane card add --layer Draft "Only on the draft layer"
kozane card layer 3f9a2c1 Draft   # move a card you already wrote
kozane layer rename Draft Sketches
kozane layer move Sketches down
```

A layer can be named by its name, its ID, or a short ID. An exact name wins.

## Tagging

A tag is text that begins with a colon. A colon also separates subcategories, so
a tag can nest without a second character:

```sh
kozane card add "caching work :perf:cache"
```

`:perf` gathers everything under it, so it finds that card and anything written
`:perf:cache` or `:perf:cache:invalidation`:

```sh
kozane tag list          # every tag in the namespace, as a tree, with counts
kozane tag show perf     # the cards and files under it, subcategories included
```

A tag exists only while it appears in text, and only where a colon opens a word. It
has to sit at the start of a line, after whitespace, or after an opening bracket, so
ordinary punctuation like `3:45` or `key: value` is never mistaken for one.

The browser tag index is available at `/tags`. Add `?namespaceId=<id>` to limit it to one
namespace. It always includes taskspace files. To list cards alone, run
`kozane tag show <tag> --no-files`.

## Seeing across namespaces

The read-only map at `/map` shows namespaces, partitions, scopes, and tags across the
workspace.

A board shows the scopes and taskspaces associated with its namespace, along with any that
have not been assigned to a namespace. The CLI provides a workspace-wide view:

```sh
kozane scope list                    # every scope, and the namespaces each one reaches
kozane taskspace list                # every taskspace, with its namespace and scope
```

Pass `--namespace <id>` to either to see exactly what that namespace's board draws.

## Security and remote access

Generate a per-workspace API key before allowing remote access:

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote --no-open
```

The key is stored separately in `.kozane/api.json` with owner-only permissions. Once that file exists, every HTTP request requires the key. API clients send it as `Authorization: Bearer <key>` (preferred) or `X-API-Key: <key>`.
`kozane api key refresh` immediately replaces the old key.

For a browser on another device, open `https://your-proxy/`. Any unauthenticated page load is redirected to a login page where you paste the key once. Kozane stores it as an HttpOnly cookie and sends you back to where you were headed.
Opening `https://your-proxy/?api_key=<key>` skips the form. Kozane exchanges the query parameter for the same cookie and removes it from the URL. API and `fetch` clients are unaffected. An unauthenticated request without a valid `Authorization: Bearer` or `X-API-Key` header still receives a `401`, not the login page.

`--allow-remote` always requires a generated key, `--no-open`, and HTTPS. Plain HTTP requests are rejected. Terminate TLS at a reverse proxy, configure the trusted protocol header as described in [Production operations](./docs/production.md), and use firewall restrictions and an unprivileged runtime user.

For a full breakdown of what each run mode exposes, see the [Security matrix](./docs/security-matrix.md).

## Publishing a read-only static site

Export the current workspace as a static site:

```sh
kozane net ssg generate --out ./site
```

When hosting under a subdirectory, such as `https://[username].github.io/kozane/`, pass the base path:

```sh
kozane net ssg generate --out ./site --base /kozane
```

The output directory includes a `.nojekyll` file so GitHub Pages serves SvelteKit's `_app/` directory. Commit the directory to a branch and enable Pages for it. Static export requires the source build toolchain, so run it from a cloned repository after `pnpm install`.

By default, the export includes only the card board, without scopes or taskspaces. Pass `--include-scoped-files` to also bake in scopes, taskspace names, and a read-only, browsable copy of each taskspace's files:

```sh
kozane net ssg generate --out ./site --include-scoped-files
```

This publishes real file contents from your local taskspace directories, so only use it on a workspace you're comfortable making public. Only taskspaces that belong to a scope are exported, because those are the ones a board draws. A taskspace outside every scope stays off the export entirely.

Each exported taskspace is capped at 20MB of embedded content and 50,000 entries. Files beyond the content cap, files over 1MB, and non-text files are still listed by name, but they open with an explanation instead of their contents. A directory past the entry cap is marked as not included. Dotfiles are never included, and symlinks are listed but never followed, the same as in the live file panel. No other files are skipped, so a taskspace pointed at a large checkout with `node_modules` will hit these limits.

Those caps are per taskspace per page, not per export. A taskspace you have not assigned to a namespace is drawn on every namespace's board, so its files are embedded in every namespace's page. Across five namespaces, a 20MB taskspace adds 100MB to the export. The directory is only walked once, but the bytes land once per page. Assign a taskspace to a namespace if you do not want it published board-wide.

Preview it over HTTP, not by opening the files directly.

```sh
kozane net ssg preview      # serves ./site at http://127.0.0.1:17174
```

`kozane net ssg preview` resolves URLs the same way GitHub Pages does, so it matches what you get once deployed. Use `--out <dir>` to serve a different directory, `--port` and `--host` (or `KOZANE_PREVIEW_PORT` and `KOZANE_PREVIEW_HOST`) to change the address, and `--no-open` to skip launching a browser. If the site was built with `--base`, preview it with the same base:

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
For persisted-cache contents, refresh rules, and safe cleanup, see
[Cache behavior](./docs/cache.md).

## License

See [LICENCE](./LICENCE).
