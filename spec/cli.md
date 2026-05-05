# Kozane CLI Specification

## Overview

Kozane is a local-first CLI tool for card-based thinking and file-based writing.
The CLI starts a local SvelteKit web server and manages project initialization,
database bootstrapping, working-copy files, and workspace health.

```
kozane
  = local-first CLI tool
  + SvelteKit web UI (served from build/)
  + SQLite metadata database
  + working-copy file generator
```

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

Working copies live wherever the user chooses (default: project root).
Each working copy directory carries its own identity marker:

```
<working-copy-dir>/
  .working-copy.json      # identity anchor
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

Output:

```
Initializing Kozane workspace "my-project"...

Kozane initialized.

  Workspace: my-project
  Config   : .kozane/config.json
  Database : .kozane/kozane.db

Next: run "kozane project create <name>" to create your first project.
```

---

### `kozane open`

Starts the local Kozane web UI and (by default) opens the browser.

```bash
kozane open [--host <host>] [--port <port>] [--no-open]
```

Options:

| Flag        | Default     | Description                              |
| ----------- | ----------- | ---------------------------------------- |
| `--host`    | `127.0.0.1` | Bind host (from config if unset)         |
| `--port`    | `5173`      | Port number (from config if unset)       |
| `--no-open` | false       | Start server without opening the browser |

Behavior:

1. Walks up from CWD to find `.kozane/config.json` → project root.
2. Checks DB migration status; exits with an error if migrations are not current.
3. Sets `DATABASE_URL`, `KOZANE_WORKSPACE_ROOT`, `HOST`, and `PORT` env vars.
4. Spawns the built server at `build/index.js`.
5. Prints the local URL, then (unless `--no-open`) opens the browser after 1 s.

Output:

```
Kozane workspace: my-project
Database: .kozane/kozane.db

Local UI:
http://127.0.0.1:5173
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
  ✓  Port 5173 available
```

---

### `kozane status`

Shows the current project state from the database.

```bash
kozane status
```

Output:

```
Workspace    : my-project
Projects     : 1
Bundles      : 6
Cards        : 128
Scopes       : 4
Working copies: 3
```

---

### `kozane project list`

Lists all projects in the current workspace.

```bash
kozane project list
```

Output (one line per project):

```
019dddef-87e3-7000-0000-000000000000  my-project
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
  id  : 019dddef-87e3-7000-0000-000000000000
  name: my-project
```

---

### `kozane project delete <id>`

Deletes a project by ID (cascade-deletes its bundles and cards).

```bash
kozane project delete <id>
```

Output:

```
Project deleted.
  id: 019dddef-87e3-7000-0000-000000000000
```

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

---

### `kozane db migrate`

Backs up the database, then applies pending migrations.

```bash
kozane db migrate
```

Behavior:

1. Checks migration status; exits early if already current.
2. Exits with an error if the database file is missing or status is unknown.
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

| Flag        | Description                              |
| ----------- | ---------------------------------------- |
| `--compact` | Write compact JSON instead of formatted  |

Behavior:

- Requires migrations to be current.
- Writes to `file` if given; otherwise prints to stdout.

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

| Flag      | Description                                             |
| --------- | ------------------------------------------------------- |
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

### `kozane wc scan`

Scans the filesystem for working copies and reports differences from the database.
**Dry-run by default** — pass `--apply` to write changes.

```bash
kozane wc scan [--apply] [--reattach] [--cleanup]
```

Options:

| Flag         | Description                                                                  |
| ------------ | ---------------------------------------------------------------------------- |
| `--apply`    | Write changes to the database (required by `--reattach` and `--cleanup`)     |
| `--reattach` | Re-link orphan working copies found on disk but missing from DB (needs `--apply`) |
| `--cleanup`  | Delete DB records for working copies whose marker file is missing (needs `--apply`) |

Behavior:

1. Walks directories listed in `config.workingCopy.searchRoots`.
2. For each `<dir>/.working-copy.json` found, reads the `workingCopyId`.
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
  wc scan --apply             update 1 moved path(s)
  wc scan --apply --reattach  reattach 1 orphan(s)
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

### `kozane wc create <name>`

Creates a new working copy.

```bash
kozane wc create <name> [--scope <scopeId>] [--no-scope] [--dir <path>]
```

Options:

| Flag                | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `--scope <scopeId>` | Attach working copy to an existing scope                                 |
| `--no-scope`        | Create without a scope (mutually exclusive with `--scope`)               |
| `--dir <path>`      | Target directory (default: `<projectRoot>/<name>`)                       |

Either `--scope` or `--no-scope` is required.

Behavior:

1. Inserts a `working_copy` DB record → gets a stable UUID.
2. Creates the target directory.
3. Writes `<dir>/.working-copy.json` with the stable ID.
4. Stores the path in the DB (`project_relative` if inside project root, `absolute` otherwise).

Output:

```
Working copy created.
  id   : 019dddef-87e3-7127-b5c9-0d5878bbf826
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
    "port": 5173
  },
  "workingCopy": {
    "defaultDir": ".",
    "searchRoots": ["."]
  },
  "ui": {
    "defaultFontSize": 11.5,
    "defaultFontFamily": "monospace",
    "defaultCardWidth": 240,
    "defaultZoom": 1,
    "leftPanelWidth": 216,
    "rightPanelWidth": 232,
    "defaultShowFooter": false,
    "defaultShowSidePanel": false,
    "canvasWidth": 2800,
    "canvasHeight": 2000
  }
}
```

---

## Working copy marker

Identity anchor written at the root of each working copy directory at creation time:

```
<working-copy-dir>/.working-copy.json
```

```json
{
  "kind": "kozane.workingCopy",
  "version": 1,
  "workingCopyId": "019dddef-87e3-7127-b5c9-0d5878bbf826",
  "projectId": "019dddef-87e3-7000-0000-000000000000"
}
```

The marker is the **filesystem anchor**. The database stores only the last-known
path. Renaming or moving the directory does not change the working copy's identity —
`kozane wc scan --apply` recovers the new path automatically.

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

| Location relative to project root | Stored `path_kind`  | Stored `path`            |
| --------------------------------- | ------------------- | ------------------------ |
| Inside project root               | `project_relative`  | relative path from root  |
| Outside project root              | `absolute`          | absolute filesystem path |

This keeps repo-local paths portable across machines while still supporting
working copies placed anywhere on the filesystem.

---

## Database schema (working_copy)

| Column         | Type                | Notes                            |
| -------------- | ------------------- | -------------------------------- |
| `id`           | text PK             | UUID v7, stable identity         |
| `project_id`   | text FK → project   | nullable; cascade delete         |
| `scope_id`     | text FK → scope     | nullable; set null on delete     |
| `name`         | text                | display name                     |
| `path`         | text                | current known filesystem path    |
| `path_kind`    | text enum           | `project_relative` \| `absolute` |
| `last_seen_at` | integer (timestamp) | set by `wc scan`                 |
| `created_at`   | integer (timestamp) | set on insert                    |
| `updated_at`   | integer (timestamp) | set on every update              |

---

## Collision handling (wc scan)

| Situation                                    | Behavior                                            |
| -------------------------------------------- | --------------------------------------------------- |
| Marker found, DB record missing              | Reported as orphan; `--apply --reattach` re-links   |
| DB record exists, marker missing             | Reported as "missing"; `--apply --cleanup` deletes  |
| Same `workingCopyId` in multiple directories | Reported as duplicate; use `kozane wc fork` (v0.2)  |

---

## v0.1 scope

```
CLI:
  kozane init
  kozane open
  kozane doctor
  kozane status
  kozane project list
  kozane project create
  kozane project delete
  kozane db status
  kozane db migrate
  kozane db export
  kozane db import
  kozane db restore
  kozane wc scan
  kozane wc create

UI (SvelteKit):
  project dashboard
  bundle list
  card creation / editing
  scope builder
  working-copy creation

Filesystem:
  .working-copy.json marker
  working-copy directory creation
```

## Planned (v0.2+)

```
kozane export <scope-id>         # export scope cards to markdown
kozane wc repair <id> --path ... # rewrite missing marker after confirmation
kozane wc fork <dir>             # assign new id to a duplicate
kozane scope list / inspect
kozane card add / list / search
```
