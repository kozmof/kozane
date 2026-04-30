# Kozane CLI Specification

## Overview

Kozane is a local-first CLI tool for card-based thinking and file-based writing.
The CLI starts a local SvelteKit UI (similar to Storybook) and manages project
initialization, database bootstrapping, working-copy files, and workspace health.

```
kozane
  = local-first CLI tool
  + SvelteKit web UI
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
    working-copies/       # default location for working copies
```

Each working copy directory carries its own identity marker:

```
<working-copy-dir>/
  .kozane/
    working-copy.json     # identity anchor
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
2. Creates `.kozane/` and `.kozane/working-copies/`.
3. Writes `.kozane/config.json` with defaults (project name = current directory name).
4. Runs Drizzle migrations to create `.kozane/kozane.db`.

Output:

```
Initializing Kozane project "my-project"...

Kozane initialized.

  Project : my-project
  Config  : .kozane/config.json
  Database: .kozane/kozane.db

Run "kozane dev" to start the local UI.
```

---

### `kozane dev`

Starts the local SvelteKit UI.

```bash
kozane dev [--host <host>] [--port <port>] [--open]
```

Options:

| Flag     | Default     | Description                        |
| -------- | ----------- | ---------------------------------- |
| `--host` | `127.0.0.1` | Bind host (from config if unset)   |
| `--port` | `5173`      | Port number (from config if unset) |
| `--open` | false       | Open browser automatically         |

Behavior:

1. Walks up from CWD to find `.kozane/config.json` → project root.
2. Sets `DATABASE_URL=file:<absolute>/.kozane/kozane.db`.
3. Spawns `vite dev` with the resolved host and port.
4. Prints the local URL.

Output:

```
Kozane project: my-project
Database: .kozane/kozane.db

Local UI:
http://127.0.0.1:5173
```

---

### `kozane open`

Alias for `kozane dev --open`. Starts the server and opens the browser.

```bash
kozane open [--host <host>] [--port <port>]
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
| Kozane project found          | `.kozane/config.json` found by walking up from CWD |
| `.kozane/` directory exists   | directory present at project root                  |
| `config.json` valid           | parses as valid JSON with expected shape           |
| `kozane.db` readable/writable | file exists and has `rw` permissions               |
| DB schema valid               | `project` table is queryable                       |
| Port available                | configured port not already in use                 |

Exit code `0` if all checks pass, `1` otherwise.

Output:

```
  ✓  Kozane project found — /path/to/project
  ✓  .kozane/ directory exists
  ✓  config.json valid
  ✓  kozane.db readable/writable
  ✓  DB schema valid
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
Project      : my-project
Projects     : 1
Bundles      : 6
Cards        : 128
Scopes       : 4
Working copies: 3
```

---

### `kozane wc scan`

Scans the filesystem for working copies and syncs their paths in the database.

```bash
kozane wc scan [--reattach]
```

Options:

| Flag         | Description                                                     |
| ------------ | --------------------------------------------------------------- |
| `--reattach` | Re-link orphan working copies found on disk but missing from DB |

Behavior:

1. Walks directories listed in `config.workingCopy.searchRoots`.
2. For each `<dir>/.kozane/working-copy.json` found, reads the `workingCopyId`.
3. Compares with DB records:
   - **Path changed** → updates `path` and `lastSeenAt` in DB.
   - **DB record missing** → reports as orphan; with `--reattach`, inserts the record.
   - **Marker missing for DB record** → reports as "missing".
4. Updates `lastSeenAt` for all matched records.

Output:

```
  ok      <id>  .kozane/working-copies/my-draft
  moved   <id>
    old: docs/readme
    new: docs/readme-v2
  orphan  <id>  /external/path/to/dir

Scan complete. 1 updated, 0 orphan(s).
```

---

### `kozane wc create <name>`

Creates a new working copy.

```bash
kozane wc create <name> [--scope <scopeId>] [--dir <path>]
```

Options:

| Flag                | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `--scope <scopeId>` | Attach working copy to an existing scope                    |
| `--dir <path>`      | Target directory (default: `.kozane/working-copies/<name>`) |

Behavior:

1. Inserts a `working_copy` DB record → gets a stable UUID.
2. Creates the target directory.
3. Writes `<dir>/.kozane/working-copy.json` with the stable ID.
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
    "defaultDir": ".kozane/working-copies",
    "searchRoots": [".", ".kozane/working-copies"]
  }
}
```

---

## Working copy marker

Identity anchor written inside each working copy directory at creation time:

```
<working-copy-dir>/.kozane/working-copy.json
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
`kozane wc scan` recovers the new path automatically.

---

## Project detection

Any command that needs a project (all except `init`) walks up from `process.cwd()`
looking for `.kozane/config.json`. This allows running commands from any
subdirectory of a project:

```bash
cd my-project/docs/chapter-1
kozane status   # resolves to my-project/.kozane/
```

If no project is found, the command prints:

```
No Kozane project found. Run "kozane init" first.
```

and exits with code `1`.

---

## Path storage policy

| Location relative to project root | Stored `path_kind` | Stored `path`            |
| --------------------------------- | ------------------ | ------------------------ |
| Inside project root               | `project_relative` | relative path from root  |
| Outside project root              | `absolute`         | absolute filesystem path |

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

| Situation                                    | Behavior                                           |
| -------------------------------------------- | -------------------------------------------------- |
| Marker found, DB record missing              | Reported as orphan; `--reattach` re-links it       |
| DB record exists, marker missing             | Reported as "missing"                              |
| Same `workingCopyId` in multiple directories | Reported as duplicate; use `kozane wc fork` (v0.2) |

---

## v0.1 scope

```
CLI:
  kozane init
  kozane dev / open
  kozane doctor
  kozane status
  kozane wc scan
  kozane wc create

UI (SvelteKit):
  project dashboard
  bundle list
  card creation / editing
  scope builder
  working-copy creation

Filesystem:
  .kozane/working-copy.json marker
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
