# Kozane CLI Specification

## Overview

Kozane is a local-first CLI tool for card-based thinking and file-based writing.
The CLI starts a local SvelteKit web server and manages project initialization,
database bootstrapping, taskspace files, and workspace health.

```
kozane
  = local-first CLI tool
  + SvelteKit web UI (served from build/)
  + SQLite metadata database
  + taskspace file generator
```

---

## Core concepts

### Projects

A project is the top-level container. It owns bundles, and bundles own cards.
Most operations (card creation, bundle management, card positions) are scoped to a single project.

### Bundles

A bundle is a named label attached to every card. Each project has one default bundle
("General") created automatically. Bundles give cards a colour in the UI and act as
a coarse categorisation — not a folder hierarchy.

### Layers

A layer is a surface within a project that cards sit on. Every card belongs to exactly one
layer, and every project has one default layer ("Base") created automatically. Layers are
stacked: the UI draws the selected layer at full strength with the rest dimmed behind it,
so one set of cards can be worked on without the others in the way.

Layers are ordered by position, bottom to top. `kozane layer move` shifts a layer one step
at a time; `layer list` prints them in the same bottom-to-top order.

Unlike bundles and scopes, a layer can be named on the command line by its name as well as
by its full or short ID — names are unique within a project. An exact name wins, then a
case-insensitive one, then a short ID.

Deleting a layer does not delete its cards: they move to the project's default layer. The
default layer cannot be deleted.

### Warps

A warp is a saved place on a project's canvas: a point the browser UI moves the view to
with the arrow keys. Warps have no name — they are numbered by creation order — and no
CLI commands, since a viewport position means nothing in a terminal. They are listed here
because they are project data: `kozane db export` carries them, and deleting a project
deletes its warps. See the [Browser UI handbook](../docs/browser-ui-handbook.md).

### Scopes

A scope is a **named cross-project grouping of cards**. Unlike projects and bundles,
a scope does not belong to any one project — the same scope can contain cards from
multiple projects simultaneously.

```
scope "Q3 planning"
  ├── card from project "backend"   (bundle: Roadmap)
  ├── card from project "backend"   (bundle: Risks)
  └── card from project "frontend"  (bundle: Roadmap)
```

Scopes are the bridge between the card canvas and the filesystem. A **taskspace** for a scope stores an identity marker. Run `kozane card list` from
that directory to read the scope's current cards directly from the database, regardless of
which project they belong to.

Cards are added to a scope explicitly (via the UI's scope panel or `taskspace create --scope`).
Deleting a scope from the UI removes that project's cards from it; the scope itself
is only deleted when it has no member cards left across any project.

### Taskspaces

A taskspace is a filesystem directory tied to a scope. It holds:

- `.taskspace.json` — identity anchor (stable UUID, survives rename/move)
- `kozane card list` — dynamically lists scope cards. If the scope was deleted or the taskspace was created without one, the CLI reports that status and lists directly associated cards

Taskspaces are discovered by `kozane taskspace scan`, which walks the directories listed
in `config.taskspace.searchRoots` and reconciles what is on disk with the database.

---

## Installation

Development (from source):

```bash
pnpm cli <command>        # via tsx (no compile step)
pnpm build:cli            # compile to dist/
```

---

## Project layout

```
<project-root>/
  .kozane/
    config.json           # project config
    kozane.db             # SQLite database
    backups/              # database backups created before migrations/imports
```

Taskspaces live wherever the user chooses (default: project root).
Each taskspace directory carries its own identity marker:

```
<taskspace-dir>/
  .taskspace.json      # identity anchor
  <exported files>
```

---

## Commands

### `kozane init`

Initializes Kozane in the current directory.

```bash
kozane init
```

Behavior:

1. Refuses if `.kozane/` already exists.
2. Creates `.kozane/`.
3. Writes `.kozane/config.json` with defaults (workspace name = current directory name).
4. Runs Drizzle migrations to create `.kozane/kozane.db`.
5. Creates a project named `main`, marks it as the workspace default, and creates its default `General` bundle.

Output:

```
Initializing Kozane workspace "my-project"...

Kozane initialized.

  Workspace: my-project
  Config   : .kozane/config.json
  Database : .kozane/kozane.db

Default project: main
```

---

### `kozane open`

Starts the local Kozane web UI and (by default) opens the browser.

```bash
kozane open [--host <host>] [--port <port>] [--memory] [--log-requests] [--no-open]
```

Options:

| Flag             | Default     | Description                              |
| ---------------- | ----------- | ---------------------------------------- |
| `--host`         | `127.0.0.1` | Bind host (from config if unset)         |
| `--port`         | `17173`     | Port number (from config if unset)       |
| `--memory`       | false       | Use a fresh database for this server run |
| `--log-requests` | false       | Log each HTTP request as structured JSON |
| `--no-open`      | false       | Start server without opening the browser |

Host and port are resolved in this order, first match wins:

1. `--host` / `--port`
2. `KOZANE_HOST` / `KOZANE_PORT` (empty values are ignored)
3. `server.host` / `server.port` in `.kozane/config.json`
4. The built-in defaults `127.0.0.1` and `17173`

`17173` avoids the ports popular dev servers claim by default (Vite `5173`, Vite preview
`4173`, `3000`, `8080`, …) and sits below the Linux ephemeral range, so it is not handed
out to outgoing connections. An explicit port that is not an integer between 0 and 65535
is an error; the command does not fall through to the next source. Port `0` asks the OS
for an ephemeral port.

Behavior:

1. Walks up from CWD to find `.kozane/config.json` → project root.
2. Checks DB migration status; exits with an error if migrations are not current. With
   `--memory`, creates and migrates a fresh temporary session database with one project named
   `:memory:` instead. While the server is running, project-dependent CLI commands use this
   database and select its sole project automatically, so `--project` can be omitted.
3. Sets `DATABASE_URL`, `KOZANE_WORKSPACE_ROOT`, `HOST`, and `PORT` env vars.
4. Spawns the built server at `build/index.js`.
5. Prints the local URL, then (unless `--no-open`) opens the browser after 1 s.

Output:

```
Kozane workspace: my-project
Database: .kozane/kozane.db

Local UI:
http://127.0.0.1:17173
```

If the database needs migration, the command exits before starting:

```
Kozane database needs attention before the UI can start.
...
Run: kozane db migrate
```

---

### `kozane doctor`

Checks the Kozane project environment and reports health.

```bash
kozane doctor
```

Checks (in order):

| Check                         | Pass condition                                     |
| ----------------------------- | -------------------------------------------------- |
| Kozane workspace found        | `.kozane/config.json` found by walking up from CWD |
| `.kozane/` directory exists   | directory present at project root                  |
| `config.json` valid           | parses as valid JSON with expected shape           |
| `kozane.db` readable/writable | file exists and has `rw` permissions               |
| DB migrations current         | migration status is `current`                      |
| Port available                | configured port not already in use                 |

Exit code `0` if all checks pass, `1` otherwise.

Output:

```
  ✓  Kozane workspace found — /path/to/project
  ✓  .kozane/ directory exists
  ✓  config.json valid
  ✓  kozane.db readable/writable
  ✓  DB migrations current
  ✓  Port 17173 available
```

A failed `config.json valid` check points at `kozane doctor config`, which reports what
is actually wrong. `doctor` itself keeps running through a broken config.

---

### `kozane doctor config`

Checks `.kozane/config.json` and reports **every** problem at once, unlike the commands
that read the config for real and stop at the first one.

```bash
kozane doctor config
kozane doctor config --strict
```

| Severity    | Reported for                                                                |
| ----------- | --------------------------------------------------------------------------- |
| `✗` error   | unreadable file, invalid JSON, missing required key, invalid value          |
| `⚠` warning | unknown key, with the nearest known key suggested when it looks like a typo |
| `ℹ` note    | unset optional keys, each listed with the default standing in for it        |

Required: `name`, `taskspace.defaultDir`, `taskspace.searchRoots`. Optional: everything
under `server` and `ui` — each falls back to its built-in default.

Exit code `1` when there is at least one error, `0` otherwise. `--strict` makes warnings
fail too, for setups that want an unknown key to break the build.

Output:

```
Config: /path/to/project/.kozane/config.json

  ✗  name is missing
  ✗  server.port must be between 0 and 65535 (found: 70000)
  ⚠  server.protocol is not a known key
  ⚠  ui.defaultFontSze is not a known key — did you mean "defaultFontSize"?
  ℹ  server: 1 of 2 keys not set — using defaults
       host: "127.0.0.1"
  ℹ  ui: 22 of 23 keys not set — using defaults
       defaultFontSize: 11.5
       defaultFontFamily: "monospace"
       …

2 errors, 2 warnings
```

Each note names the keys behind the count, so the defaults a workspace is running on are
visible without going to look them up.

---

### `kozane status`

Shows whether the server is stopped or running in persistent/`:memory:` mode, plus the
current project state. While a memory server is running, counts come from its temporary
session database.

```bash
kozane status
```

Output:

```
Workspace    : my-project
Opening      : running (:memory:)
Projects     : 1
Bundles      : 6
Cards        : 128
Scopes       : 4
Taskspaces: 3
```

---

### `kozane project list`

Lists all projects in the current workspace.

```bash
kozane project list
```

Output (one line per project):

```
aa414b7  main  (default)
```

If no projects exist:

```
No projects found.
```

---

### `kozane project create <name>`

Creates a new project in the current workspace.

```bash
kozane project create <name>
```

Behavior:

1. Requires a Kozane workspace (walks up from CWD).
2. Runs Drizzle migrations (idempotent).
3. Inserts a `project` DB record → gets a stable UUID.
4. Creates a default "General" bundle for the project.

Output:

```
Project created.
  id  : aa414b7
  name: my-project
```

---

### `kozane project default <id>`

Marks a project as the workspace default. The alias `project set-default <id>` is also
accepted. Commands use this project whenever `--project` is omitted. Project IDs may
be full or short.

```bash
kozane project default <id>
```

---

### `kozane project delete <id>`

Deletes a project by ID (cascade-deletes its bundles and cards). If it was the default, another remaining project is promoted automatically.

```bash
kozane project delete <id>
```

Output:

```
Project deleted.
  id: aa414b7
```

---

### `kozane scope add <name>`

Adds a cross-project card scope.

```bash
kozane scope add <name>
```

Output includes the new short scope ID and name. Scope names must be non-empty and
unique within the workspace.

### `kozane scope list`

Lists all scopes using collision-safe short IDs.

```bash
kozane scope list
```

If no scopes exist, the command prints `No scopes found.`

### `kozane scope delete <id>`

Deletes a scope workspace-wide using its full or short ID. Scope membership rows are
deleted, and attached taskspaces become unscoped. Cards themselves are retained.

```bash
kozane scope delete <id>
```

---

### `kozane layer list`

Lists a project's layers bottom to top, one per line, as short ID, position, card count,
and name. The default layer is marked `(default)`.

```bash
kozane layer list [--project <projectId>]
```

If the project has no layers, the command prints `No layers found.`

### `kozane layer add <name>`

Adds a layer on top of the project's existing ones. Output includes the new short layer ID,
name, and position.

```bash
kozane layer add <name> [--project <projectId>]
```

Layer names must be non-empty and unique within the project.

### `kozane layer rename <layer> <name>`

Renames a layer, identified by name, full ID, or short ID.

```bash
kozane layer rename <layer> <name> [--project <projectId>]
kozane layer rename Draft Sketches
```

### `kozane layer move <layer> <direction>`

Moves a layer one step up or down the stack. `<direction>` must be `up` or `down`; moving
past either end is an error, as is any other direction.

```bash
kozane layer move <layer> up|down [--project <projectId>]
kozane layer move Sketches down
```

### `kozane layer delete <layer>`

Deletes a layer and moves its cards to the project's default layer. Deleting the default
layer is refused.

```bash
kozane layer delete <layer> [--project <projectId>]
```

---

### `kozane card add <content>`

Adds a card to a project and optionally associates it with a scope.

```bash
kozane card add <content> [--project <projectId>] [--bundle <bundleId>]
                          [--scope <scopeId>] [--layer <layer>]
                          [--x <number>] [--y <number>]
```

Project, bundle, and scope options accept full or short IDs; `--layer` also accepts a layer
name. Without `--project`, the workspace default project is used. Without `--bundle`, that
project’s default bundle is used. Without `--layer`, that project's default layer is used. When `--scope` is provided, card creation and scope
membership are committed in one transaction.

Example:

```bash
kozane card add "Investigate caching" --project eb155d6 --scope e3ee90b --x 48 --y 72
```

---

### `kozane card squash [content]`

Splits text using a configurable JavaScript regular expression, trims each segment,
and adds every non-empty segment as a separate card. The default pattern splits on
`. ` (a period followed by a space), `。`, or a blank line, preserving dots inside
values such as `example.com`. Generated cards are
placed on unoccupied grid positions instead of being stacked at the same coordinates. Pass the text as an argument or pipe
it through standard input:

```bash
kozane card squash "First thought. 第二の考え。 Third thought."
cat foo.txt | kozane card squash
kozane card squash "one | two, three" --pattern '\s*[|,]\s*'
```

The command accepts `--pattern`, `--project`, `--bundle`, `--scope`, and `--layer`, using
full or short IDs — and, for `--layer`, a layer name.
These options work with piped input as well:

```bash
cat foo.txt | kozane card squash --project eb155d6 --scope e3ee90b
```

All generated cards and their optional scope memberships are committed in one
transaction, so an error does not leave a partially created set.

---

### `kozane card show <cardId>`

Prints a card content by full or short ID. Line breaks are preserved.

```bash
kozane card show <cardId>
kozane card show 17b86d2
```

---

### `kozane card layer <cardId> <layer>`

Moves an existing card to another layer of its own project. The card is found by full or
short ID, and the project is taken from the card rather than from `--project`, so the layer
is always resolved against the project that owns it. `<layer>` accepts a layer name, full
ID, or short ID.

```bash
kozane card layer <cardId> <layer>
kozane card layer 3f9a2c1 Draft
```

Moving a card to a layer of a different project is refused. A card arriving from another
layer is stacked above the cards already there.

---

### `kozane card list`

Lists project cards or dynamically lists cards associated with a taskspace.

```bash
kozane card list [--project <projectId>] [--bundle <bundleId>]
kozane card list --taskspace <path>
```

When the current directory contains `.taskspace.json`, running `kozane card list`
without project or bundle options automatically uses that marker. The marker must be
in the current directory; parent directories are not searched.

`--taskspace <path>` accepts either a taskspace directory or the
`.taskspace.json` file itself. Scoped taskspaces list the current scope members
directly from the database. If the taskspace has no scope, including when its scope
was deleted, the command prints a notice and lists cards associated directly with the
taskspace.

Examples:

```bash
cd my-taskspace
kozane card list

kozane card list --taskspace ./my-taskspace
kozane card list --taskspace ./my-taskspace/.taskspace.json
```

The taskspace form cannot be combined with `--project` or `--bundle`.

---

### `kozane card nearest <cardId>`

Lists all cards in the specified card's project, sorted by Euclidean distance from
that card's canvas position. The specified card appears first with distance `0.00`.
Cards at the same distance are ordered by ID. Full and short card IDs are accepted.

```bash
kozane card nearest <cardId>
kozane card nearest 17b86d2
```

Each row includes the card's short ID, bundle, position, distance, and content.

---

### `kozane db status`

Shows the current database migration status.

```bash
kozane db status
```

Output:

```
Database: /path/to/.kozane/kozane.db
Status  : current
Applied : 0001_init (1700000000000)
Latest  : 0001_init (1700000000000)
```

Exit code `0` if current, `1` otherwise.

States:

| Status    | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `current` | Every migration in the journal has been applied                             |
| `pending` | Newer migrations exist; run `kozane db migrate`                             |
| `missing` | The database file does not exist                                            |
| `gapped`  | A migration older than the newest applied one was never applied or was lost |
| `unknown` | The migration metadata could not be read                                    |

A `gapped` database cannot be repaired by `kozane db migrate`, which only applies
migrations newer than the newest recorded one; restore a backup instead.

---

### `kozane db migrate`

Backs up the database, then applies pending migrations.

```bash
kozane db migrate
```

Behavior:

1. Checks migration status; exits early if already current.
2. Exits with an error if the database file is missing, or status is unknown or gapped.
3. Creates a timestamped backup in `.kozane/backups/` before migrating.
4. Runs Drizzle migrations.
5. Reports the new status.

Output:

```
Backup created: .kozane/backups/kozane.20240101T120000.db
Database migrated.
Database: /path/to/.kozane/kozane.db
Status  : current
...
```

---

### `kozane db export [file]`

Exports workspace database data as JSON.

```bash
kozane db export [file] [--compact]
```

Options:

| Flag        | Description                             |
| ----------- | --------------------------------------- |
| `--compact` | Write compact JSON instead of formatted |

Behavior:

- Requires migrations to be current.
- Writes to `file` if given; otherwise prints to stdout.
- Writes export format version 5. Older files can still be imported: version 2
  (exported before projects had a default flag) comes back with every project
  non-default, version 3 (before layers) gets a rebuilt default layer per project,
  and version 4 (before warps) comes back with no warps.

Output (to file):

```
Database exported: /path/to/export.json
```

---

### `kozane db import <file>`

Imports workspace database data from a JSON file previously exported with `kozane db export`.

```bash
kozane db import <file> [--force]
```

Options:

| Flag      | Description                                                   |
| --------- | ------------------------------------------------------------- |
| `--force` | Replace existing workspace data (required if DB is not empty) |

Behavior:

1. Requires migrations to be current.
2. Refuses if the DB is not empty and `--force` is not given.
3. Creates a backup before importing.
4. Imports and prints per-table row counts.

Output:

```
Backup created: .kozane/backups/kozane.20240101T120000.db
Database imported: /path/to/export.json
project: 1
bundle: 2
card: 42
```

---

### `kozane db restore [file]`

Restores the database from a backup.

```bash
kozane db restore [file]
```

Behavior:

- If `file` is omitted, lists available backups in `.kozane/backups/` and uses the most recent.
- Backs up the current database before overwriting it (best-effort; skipped if the file is corrupted).
- Copies the chosen backup over the live database.

Output:

```
Available backups:
  kozane.20240101T120000.db ← most recent

Current database backed up: .kozane/backups/kozane.20240101T130000.db
Restored: .kozane/backups/kozane.20240101T120000.db
```

---

### `kozane taskspace scan`

Scans the filesystem for taskspaces and reports differences from the database.
**Dry-run by default** — pass `--apply` to write changes.

```bash
kozane taskspace scan [--apply] [--reattach] [--cleanup]
```

Options:

| Flag         | Description                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| `--apply`    | Write changes to the database (required by `--reattach` and `--cleanup`)        |
| `--reattach` | Re-link orphan taskspaces found on disk but missing from DB (needs `--apply`)   |
| `--cleanup`  | Delete DB records for taskspaces whose marker file is missing (needs `--apply`) |

Behavior:

1. Walks directories listed in `config.taskspace.searchRoots`.
2. For each `<dir>/.taskspace.json` found, reads the `taskspaceId`.
3. Compares with DB records:
   - **Path changed** → reports as `moved`; with `--apply`, updates `path` and `lastSeenAt`.
   - **DB record missing** → reports as `orphan`; with `--apply --reattach`, inserts the record.
   - **Marker missing for DB record** → reports as `missing`; with `--apply --cleanup`, deletes the DB record.
4. Updates `lastSeenAt` for all matched records when `--apply` is given.

Dry-run output (no `--apply`):

```
  ok      <id>  ./my-draft
  moved   <id>
    old: docs/readme
    new: docs/readme-v2
  orphan  <id>  /external/path/to/dir

To apply changes, run:
  taskspace scan --apply             update 1 moved path(s)
  taskspace scan --apply --reattach  reattach 1 orphan(s)
```

Applied output:

```
Scan complete. 1 updated.
```

With `--cleanup`:

```
Scan complete. 1 updated, 1 deleted.
```

---

### `kozane taskspace create <name>`

Creates a new taskspace.

```bash
kozane taskspace create <name> [--scope <scopeId>] [--no-scope] [--dir <path>]
```

Options:

| Flag                | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `--scope <scopeId>` | Attach taskspace to an existing scope                      |
| `--no-scope`        | Create without a scope (mutually exclusive with `--scope`) |
| `--project <id>`    | Override the workspace default project                     |
| `--dir <path>`      | Target directory (default: `<projectRoot>/<name>`)         |

Either `--scope` or `--no-scope` is required.

Behavior:

1. Inserts a `taskspace` DB record → gets a stable UUID.
2. Creates the target directory.
3. Writes `<dir>/.taskspace.json` with the stable ID.
4. Stores the path in the DB (`project_relative` if inside project root, `absolute` otherwise).

Output:

```
Taskspace created.
  id   : 0d5878b
  name : my-draft
  path : /path/to/my-draft
```

---

## Config file

`.kozane/config.json`:

```json
{
  "name": "my-project",
  "server": {
    "host": "127.0.0.1",
    "port": 17173
  },
  "taskspace": {
    "defaultDir": ".",
    "searchRoots": ["."]
  },
  "ui": {
    "defaultFontSize": 11.5,
    "defaultFontFamily": "monospace",
    "defaultCardWidth": 240,
    "newCardPlacement": "vertical-list",
    "defaultZoom": 1,
    "zoomStep": 0.05,
    "leftPanelWidth": 216,
    "rightPanelWidth": 232,
    "defaultShowFooter": false,
    "defaultShowSidePanel": false,
    "toggleFootersShortcut": "f",
    "togglePanelsShortcut": "b",
    "focusCardInputShortcut": "i",
    "clearSelectionShortcut": "Escape",
    "copyCardIdShortcut": "c",
    "bringCardToFrontShortcut": "]",
    "sendCardToBackShortcut": "[",
    "glueCardsShortcut": "g",
    "unglueCardShortcut": "u",
    "moveCardsShortcut": "m",
    "deleteCardsShortcut": "Delete",
    "canvasWidth": 5600,
    "canvasHeight": 4000
  }
}
```

Only `name` and the `taskspace` keys are required; `server` and `ui` fall back to their
built-in defaults key by key. Run [`kozane doctor config`](#kozane-doctor-config) after
editing this file by hand.

The default `"vertical-list"` stacks newly created cards downward in one non-overlapping
column. Set `ui.newCardPlacement` to `"grid"` for a compact four-column wrapping layout
with light overlap between cards.

---

## Taskspace marker

Identity anchor written at the root of each taskspace directory at creation time:

```
<taskspace-dir>/.taskspace.json
```

```json
{
  "kind": "kozane.taskspace",
  "version": 1,
  "taskspaceId": "019dddef-87e3-7127-b5c9-0d5878bbf826",
  "projectId": "019dddef-87e3-7000-ac4d-aa414b7e75d7"
}
```

The marker stores full UUIDs. Commands print the short form of the same IDs —
`0d5878b` and `aa414b7` above — and accept either.

The marker is the **filesystem anchor**. The database stores only the last-known
path. Renaming or moving the directory does not change the taskspace's identity —
`kozane taskspace scan --apply` recovers the new path automatically.

---

## Project detection

Any command that needs a workspace (all except `init`) walks up from `process.cwd()`
looking for `.kozane/config.json`. This allows running commands from any
subdirectory of a workspace:

```bash
cd my-project/docs/chapter-1
kozane status   # resolves to my-project/.kozane/
```

If no workspace is found, the command prints:

```
No Kozane workspace found. Run "kozane init" first.
```

and exits with code `1`.

---

## Path storage policy

| Location relative to project root | Stored `path_kind` | Stored `path`            |
| --------------------------------- | ------------------ | ------------------------ |
| Inside project root               | `project_relative` | relative path from root  |
| Outside project root              | `absolute`         | absolute filesystem path |

This keeps repo-local paths portable across machines while still supporting
taskspaces placed anywhere on the filesystem.

---

## Database schema (taskspace)

| Column         | Type                | Notes                            |
| -------------- | ------------------- | -------------------------------- |
| `id`           | text PK             | UUID v7, stable identity         |
| `project_id`   | text FK → project   | nullable; cascade delete         |
| `scope_id`     | text FK → scope     | nullable; set null on delete     |
| `name`         | text                | display name                     |
| `path`         | text                | current known filesystem path    |
| `path_kind`    | text enum           | `project_relative` \| `absolute` |
| `last_seen_at` | integer (timestamp) | set by `taskspace scan`          |
| `created_at`   | integer (timestamp) | set on insert                    |
| `updated_at`   | integer (timestamp) | set on every update              |

---

## Collision handling (taskspace scan)

| Situation                                  | Behavior                                                  |
| ------------------------------------------ | --------------------------------------------------------- |
| Marker found, DB record missing            | Reported as orphan; `--apply --reattach` re-links         |
| DB record exists, marker missing           | Reported as "missing"; `--apply --cleanup` deletes        |
| Same `taskspaceId` in multiple directories | Reported as duplicate; use `kozane taskspace fork` (v0.2) |

---

## v0.1 scope

```
CLI:
  kozane init
  kozane open
  kozane doctor
  kozane doctor config
  kozane status
  kozane project list
  kozane project create
  kozane project delete
  kozane db status
  kozane db migrate
  kozane db export
  kozane db import
  kozane db restore
  kozane taskspace scan
  kozane taskspace create

UI (SvelteKit):
  project dashboard
  bundle list
  card creation / editing
  scope builder
  taskspace creation

Filesystem:
  .taskspace.json marker
  taskspace directory creation
```

## Planned (v0.2+)

```
kozane export <scope-id>         # export scope cards to markdown
kozane taskspace repair <id> --path ... # rewrite missing marker after confirmation
kozane taskspace fork <dir>             # assign new id to a duplicate
kozane scope inspect
kozane card add / list / search
```
