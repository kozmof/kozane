# Kozane

Kozane is a workspace for short texts.
It builds on the kozane method (こざね法), a way of organizing thoughts on small cards developed by the Japanese anthropologist Tadao Umesao.

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

To start with an empty database that exists only for the lifetime of the server, use `kozane open --memory`. It creates a project named `:memory:`, and all changes are discarded when the server stops. `kozane init` creates a default project named `main`. Run `kozane project default <id>` to change which project commands use when `--project` is omitted.

The `/health` endpoint checks server and database readiness. It sits behind the same authentication as everything else, so once the workspace has an API key a monitoring probe has to send it too — see [Production operations](./docs/production.md).

For working in the browser UI, see the [Browser UI handbook](./docs/browser-ui-handbook.md).

## Adding cards from text

Create one card from a quoted argument:

```sh
kozane card add "Investigate caching"
```

To turn sentences into separate cards, use `card squash`. By default it splits on `. ` (a period followed by a space), `。`, and blank lines, so dots inside URLs such as `example.com` are preserved. It trims whitespace and ignores empty segments:

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

A layer is a surface cards sit on, so a set of cards can be worked on with the rest of the board dimmed behind it. Every project starts with a `Base` layer:

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

Write a tag anywhere in a card and it gathers that card with everything else carrying it —
taskspace files included, since a tag is just text and a file is too. A tag opens with an
apostrophe and subcategorizes with colons:

```sh
kozane card add "caching work 'perf:cache"
```

`'perf` gathers everything under it, so it finds that card and anything written
`'perf:cache` or `'perf:cache:invalidation`:

```sh
kozane tag list          # every tag in the project, as a tree, with counts
kozane tag show perf     # the cards and files under it, subcategories included
```

Nothing is created to make a tag exist. It is in the workspace for as long as some text
holds it, and gone once that text is. Ordinary punctuation stays punctuation: `don't` is a
word and `'quoted'` is a quoted word, and neither becomes a tag.

In the browser, the tag index is at `/tags`, linked from the project list and from every
tag written on a card. It lists every tag in the workspace and what each one gathers. Add
`?projectId=<id>` to narrow it to one project; without it, the index reaches across every
project at once — which nothing else in the UI does, and which is the point of a label that
lives in the text rather than in a table. `?files=0`, or the "Cards only" link on the page,
leaves taskspace files out — the same switch as `--no-files` above.

## Seeing across projects

The browser has one page above the boards: the map at `/map`, linked from the project list.
Every project is a rectangle, the bundles inside it are sized by how many cards they hold,
each scope is a node with a line to every bundle it reaches, and the tags are a tree you can
pick from to see where each one lives. It is read-only, and it reaches every project at once.

A board shows the scopes and taskspaces its own project uses, plus any not yet claimed by a project. A scope another project alone is working in stays off it. The CLI is the workspace-wide view:

```sh
kozane scope list                    # every scope, and the projects each one reaches
kozane taskspace list                # every taskspace, with its project and scope
```

Pass `--project <id>` to either to see exactly what that project's board draws.

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

By default, the export includes only the card board — no scopes, no taskspaces. Pass `--include-scoped-files` to also bake in scopes, taskspace names, and a read-only, browsable copy of each taskspace's files:

```sh
kozane net ssg generate --out ./site --include-scoped-files
```

This publishes real file contents from your local taskspace directories, so only use it on a workspace you're comfortable making public. Only taskspaces that belong to a scope are exported — those are the ones a board draws — so a taskspace you haven't put in a scope stays off the export entirely. Each exported taskspace is capped at 20MB of embedded content and 50,000 entries; files beyond the content cap, along with any oversized (>1MB) or non-text file, are still listed by name but open with an explanation instead of their contents, and a directory past the entry cap is marked as not included. Dotfiles are never included and symlinks are listed but never followed, the same as in the live file panel. A taskspace pointed at a large checkout will hit these limits — `node_modules` and its like are not excluded, only dotfiles are.

Those caps are per taskspace per page, not per export. A taskspace you have not assigned to a project is drawn on every project's board, so its files are embedded in every project's page: across five projects, a 20MB taskspace is 100MB of export. The directory is only walked once, but the bytes land once per page. Assign a taskspace to a project if you do not want it published board-wide.

Preview it over HTTP, not by opening the files directly.

```sh
kozane net ssg preview      # serves ./site at http://127.0.0.1:17174
```

`kozane net ssg preview` resolves URLs the same way GitHub Pages does, so it matches what you get once deployed. Use `--out <dir>` to serve a different
directory, `--port` and `--host` (or `KOZANE_PREVIEW_PORT` and `KOZANE_PREVIEW_HOST`) to change the address, and `--no-open` to skip launching a browser. If the site was built with `--base`, preview it with the same base:

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

## License

See [LICENCE](./LICENCE).
