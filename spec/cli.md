# Kozane CLI Specification

## Overview

Kozane is a local-first workspace for arranging short pieces of text on a canvas.
The CLI starts a local SvelteKit web server and manages project initialization,
database bootstrapping, taskspace files, and workspace health. This document
records the command surface the codebase implements today.

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
("General") created automatically. Bundles give cards a color in the UI and act as a
coarse category rather than a folder hierarchy.

### Layers

A layer is a surface within a project that cards sit on. Every card belongs to exactly one
layer, and every project has one default layer ("Base") created automatically. Layers are
stacked. The UI draws the selected layer at full strength with the rest dimmed behind it,
so one set of cards can be worked on without the others in the way.

Layers are ordered by position, bottom to top. `kozane layer move` shifts a layer one step
at a time, and `layer list` prints them in the same bottom-to-top order.

Unlike bundles and scopes, a layer can be named on the command line by its name as well as
by its full or short ID, because names are unique within a project. An exact name wins,
then a case-insensitive one, then a short ID.

Deleting a layer does not delete its cards. They move to the project's default layer. The
default layer cannot be deleted.

### Tags

A tag is a word written inside a card or a taskspace file, opened with an apostrophe:
`'perf`. It subcategorizes with colons — `'perf:cache`, `'perf:cache:invalidation` — and a
tag gathers everything beneath it, so `'perf` finds cards and files written `'perf:cache`.

Tags are the one label a card and a file can share, because both are just text. Nothing is
created to make a tag exist and nothing is deleted to remove one: a tag is in the workspace
for exactly as long as some text holds it. There is no tag table, and no command that adds
or removes a tag — `tag list` and `tag show` only read.

That is an invariant and not merely how it works today. A stored index would have to be
rewritten inside every transaction that writes a card's text — `card add`, `card edit`,
`card squash`, the board's own writes, `db import` — and the first writer to forget would
leave an index disagreeing with the cards, with nothing able to say so. Derived on read, a
tag exists exactly as long as the text holding it does. Any future command that appears to
name tags directly has to be a way of editing text, not a second place tags are kept.

A tag is not confined to a project, for the same reason: nothing stops the same one being
written on two boards. The browser's tag index at `/tags` gathers the whole workspace by
default and narrows to a project with `?projectId=<id>`. The CLI is the other way round —
`tag list` and `tag show` read one project, the workspace default unless `--project` names
another — because a command run inside a workspace is usually asking about the project it
is working in.

An apostrophe is also ordinary punctuation, so three rules keep writing from becoming
tagging. A tag opens at a word boundary, which leaves `don't` and `x'foo` alone; a
closing apostrophe cancels it, which leaves `'quoted'` as text; and an http(s) URL is an
address rather than text, which leaves `https://example.com/it's/fine` as one link. The URL
rule is part of the grammar rather than of the browser, so a tag is read the same way in a
card, in a file, and on screen. A level may hold letters,
digits, `-`, and `_`; it may not exceed 64 characters, and a tag may not exceed 8 levels.
Something past either limit is not a tag at all rather than a tag cut short. Tags are
matched case-insensitively, so `'Perf` and `'perf` are one tag.

A URL is a boundary as well as an exclusion, so a tag written hard against one ends where
the address begins: `'todo:https://example.com/issue/1` is the tag `'todo`, and
`'https://example.com` is no tag at all rather than the tag `'https`. That is what a card
draws, and what the index gathers, because both read the same grammar.

The cancelling rule reaches one word and no further, so `'a phrase'` still gathers under
`'a`, and so do `'til` and `'90s`. In a source file the same rule means a multi-word quoted
string opens a tag under its first word: `echo 'hello world'` gathers under `'hello`, and
`it('does a thing', …)` under `'does`. A one-word literal is cancelled like any other quoted
word, so `from 'drizzle-orm'` gathers nothing at all. That is the deliberate side to err
on — a tag nobody meant is one row to ignore, a tag swallowed is a card that cannot be
found — and it is bounded by what the scan walks rather than by a second grammar for files.

Both front ends can put the file half down entirely: `tag show --no-files` and, in the
browser, `?files=0` on the tag index. Each skips the disk walk rather than hiding what it
found, which is the answer for a taskspace that is a source checkout — the tags written on
cards are still gathered.

Taskspace files are read on demand, within the same boundary the browser's file panel holds:
dot-entries such as `.git` and `.env` are never read, symlinks are never followed, and a
file that is not UTF-8 text or is over 1 MB is passed over. A taskspace too large to read in
full is reported as such rather than quietly half-read, and each reason is reported as
itself: a file larger than one file may be is not described as one that could not be read.
A reason that is about particular files names a few of them, since "some files could not be
read" describes a taskspace with one bad file and one that is wholly unreadable identically
and gives neither reader anywhere to look.

The cards are bounded too, at a hundred thousand hits for one gather, and say so the same
way. It is not a ceiling a workspace of notes comes near; it is there because the tags on
cards and the tags in files fill the same list, and a list that has been cut without saying
so makes every count taken from it read as exact when it is a floor.

`tag show` prints at most 200 card hits and at most 200 file hits, the same two ceilings the
browser's index draws, and says so when it has cut a list. The two are separate because the
hits arrive cards first, so one ceiling across both would print no files at all for a tag
written on hundreds of cards. The counts in `tag list` are always of everything.

Generated and vendored directories are not walked, at any depth: `node_modules`,
`bower_components`, `vendor`, `build`, `dist`, `out`, `target`, `coverage`, `__pycache__`,
and `tmp`. They are not reported as a truncation, because a taskspace read to the end of
everything the scan covers _was_ read in full — they are simply outside it, as dot-entries
are. A `.gitignore` is not consulted: it answers a different question, varies per repository,
and routinely covers notes someone would want tagged.

### Warps

A warp is a saved place on a project's canvas, a point the browser UI moves the view to
with the arrow keys. Warps have no name and are numbered by creation order. They have no
CLI commands either, since a viewport position means nothing in a terminal. They are
listed here because they are project data. `kozane db export` carries them, and deleting
a project deletes its warps. See the
[Browser UI handbook](../docs/browser-ui-handbook.md).

### Scopes

A scope is a named cross-project grouping of cards. Unlike projects and bundles, a scope
does not belong to any one project, so the same scope can contain cards from multiple
projects at once.

```
scope "Q3 planning"
  ├── card from project "backend"   (bundle: Roadmap)
  ├── card from project "backend"   (bundle: Risks)
  └── card from project "frontend"  (bundle: Roadmap)
```

Scopes are the bridge between the card canvas and the filesystem. A taskspace for a scope
stores an identity marker. Run `kozane card list` from that directory to read the scope's
current cards directly from the database, regardless of which project they belong to.

A board shows only the scopes its own project has reason to draw: those holding one of its
cards, those one of its taskspaces is attached to, and those nothing anywhere refers to yet.
A scope used only by another project is not on it. The CLI is the workspace-wide view —
`kozane scope list` names every scope and the projects each one reaches, and
`kozane taskspace list` does the same for taskspaces. Pass `--project` to either to see
exactly what that project's board draws.

Cards are added to a scope explicitly (via the UI's scope panel or `taskspace create --scope`).
Deleting a scope from the UI removes that project's cards from it. The scope itself is only
deleted once nothing anywhere refers to it: no member cards in any project, and no
taskspaces attached. A scope another project has attached a taskspace to but not yet filed
cards into therefore survives, rather than being removed out from under it.

`kozane scope delete` is the blunter one: it deletes the scope workspace-wide whatever
still refers to it, leaving those taskspaces unscoped.

### Taskspaces

A taskspace is a filesystem directory tied to a scope. It holds one file that Kozane
writes:

- `.taskspace.json` — identity anchor (stable UUID, survives rename and move)

Run `kozane card list` from a taskspace directory to list the scope's current cards. If
the scope was deleted, or the taskspace was created without one, the CLI reports that
status and lists the cards associated directly with the taskspace.

Taskspaces are discovered by `kozane taskspace scan`, which walks the directories listed
in `config.taskspace.searchRoots` and reconciles what is on disk with the database.
`kozane taskspace list` reads only the database and reports every taskspace with the
project and scope it sits under.

A taskspace records the project it was created for, and a board shows its own project's
taskspaces. `taskspace create` always settles on one — `--project` if given, otherwise the
default project, otherwise the only project there is — and exits with an error when none of
those applies. It never creates a taskspace with no project.

A record can still end up without one through `taskspace scan --apply --reattach`, which
inserts from the on-disk marker: a marker naming no project gives a taskspace with none,
and that taskspace appears on every board until something places it.

---

## Installation

Published package:

```bash
npm install --global kozane   # or: npm install --save-dev kozane
```

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
    tag-index.json        # cached tag gather, rebuilt when stale, safe to delete
    backups/              # database backups created before migrations/imports
```

Taskspaces live wherever you choose (default: project root).
Each taskspace directory carries its own identity marker:

```
<taskspace-dir>/
  .taskspace.json      # identity anchor
  <exported files>
```

---

## Commands

### What every workspace command does first

`project`, `card`, `layer`, `scope`, `taskspace` and `status` all open the workspace the
same way, and it is the same three steps every time.

1. **Find the workspace**, walking up from the current directory. Without one, the command
   exits 1 with `No Kozane workspace found. Run "kozane init" first.`
2. **Require the database to be current.** A database missing migrations stops the command
   with the same report `kozane open` gives, and a pointer to `kozane db migrate` — or to
   `kozane db status` and `kozane doctor` when the history has gaps, which `db migrate`
   cannot repair. No command migrates on its way past: migrations take a backup first, and
   that only happens when `kozane db migrate` is asked for by name. `kozane status` is the
   exception and reports on a workspace whatever state it is in.
3. **Open the session database.** While a `kozane open --memory` server is running, that is
   its temporary database rather than `.kozane/kozane.db`, so these commands act on the
   board that is actually open.

Anything thrown after that becomes `Error: <message>` on stderr and exit 1.

`init`, `open`, `doctor`, `net ssg` and the `db` commands are outside this: each opens the
on-disk database directly, because each has a reason to run when the steps above would
refuse.

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
kozane open [--host <host>] [--port <port>] [--memory] [--log-requests]
            [--allow-remote] [--no-open]
```

Options:

| Flag             | Default     | Description                                        |
| ---------------- | ----------- | -------------------------------------------------- |
| `--host`         | `127.0.0.1` | Bind host (from config if unset)                   |
| `--port`         | `17173`     | Port number (from config if unset)                 |
| `--memory`       | false       | Use a fresh temporary database for this server run |
| `--log-requests` | false       | Log each HTTP request as structured JSON           |
| `--allow-remote` | false       | Serve through an HTTPS reverse proxy (see below)   |
| `--no-open`      | false       | Start server without opening the browser           |

`--allow-remote` requires a generated API key and `--no-open`, and it rejects plain HTTP.
See the [Security matrix](../docs/security-matrix.md) for what each run mode exposes.

Host and port are resolved in this order, first match wins:

1. `--host` / `--port`
2. `KOZANE_HOST` / `KOZANE_PORT` (empty values are ignored)
3. `server.host` / `server.port` in `.kozane/config.json`
4. The built-in defaults `127.0.0.1` and `17173`

`17173` avoids the ports popular dev servers claim by default (Vite `5173`, Vite preview
`4173`, `3000`, `8080`, …) and sits below the Linux ephemeral range, so it is not handed
out to outgoing connections. An explicit port that is not an integer between 0 and 65535
is an error, and the command does not fall through to the next source. Port `0` asks the
OS for an ephemeral port.

Behavior:

1. Walks up from CWD to find `.kozane/config.json` → project root.
2. Checks DB migration status and exits with an error if migrations are not current. With
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

### `kozane api key generate`

Generates the workspace API key and prints it once. The key is written to
`.kozane/api.json` with owner-only permissions. Once that file exists, every HTTP request
needs the key.

```bash
kozane api key generate
```

Exits with an error if a key already exists, pointing at `kozane api key refresh`.

### `kozane api key refresh`

Replaces the existing key with a new one and prints it. The previous key stops working
immediately.

```bash
kozane api key refresh
```

Exits with an error if no key exists yet.

---

### `kozane net ssg generate`

Builds a read-only static site from the current workspace, for hosting on GitHub Pages or
any static host. The export carries a full snapshot of the database and has no server, so
every write operation is disabled in it.

```bash
kozane net ssg generate [--out <dir>] [--base <path>]
```

Options:

| Flag            | Default   | Description                                                |
| --------------- | --------- | ---------------------------------------------------------- |
| `--out <dir>`   | `./site`  | Output directory, emptied and rewritten on each run        |
| `--base <path>` | site root | Base path when hosted under a subdirectory, e.g. `/kozane` |

Requires migrations to be current, and requires the source build toolchain, so run it from
a cloned repository after `pnpm install`. The output directory gets a `.nojekyll` file so
GitHub Pages serves SvelteKit's `_app/` directory.

### `kozane net ssg preview`

Serves a generated site over HTTP, resolving URLs the way GitHub Pages does.

```bash
kozane net ssg preview [--out <dir>] [--base <path>] [--host <host>] [--port <port>] [--no-open]
```

Options:

| Flag            | Default     | Description                                  |
| --------------- | ----------- | -------------------------------------------- |
| `--out <dir>`   | `./site`    | Directory to serve                           |
| `--base <path>` | site root   | Base path the site was built with            |
| `--host`        | `127.0.0.1` | Bind host (or `KOZANE_PREVIEW_HOST`)         |
| `--port`        | `17174`     | Port number (or `KOZANE_PREVIEW_PORT`)       |
| `--no-open`     | false       | Start the server without opening the browser |

Exits with an error if the directory holds no `index.html`.

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
| Card timestamps valid         | every card's timestamps name a moment              |
| Port available                | configured port not already in use                 |

Exit code `0` if all checks pass, `1` otherwise.

Output:

```
  ✓  Kozane workspace found — /path/to/project
  ✓  .kozane/ directory exists
  ✓  config.json valid
  ✓  kozane.db readable/writable
  ✓  DB migrations current
  ✓  Card timestamps valid
  ✓  Port 17173 available
```

A failed `config.json valid` check points at `kozane doctor config`, which reports what
is actually wrong. `doctor` itself keeps running through a broken config.

`Card timestamps valid` runs only when the migrations are current, since it reads columns
that migration 0011 adds. It reports cards whose `created_at` or `updated_at` falls outside
the range a timestamp this app wrote can hold — at or before the epoch, or past the largest
instant a date can represent. The epoch is what a hand-written `INSERT INTO card` naming
neither column leaves behind, since the columns carry a `DEFAULT 0` that SQLite will not let
the schema drop; a value beyond the date range is one only hand-written SQL can put there.
Every insert the app makes writes both columns, so any such card means the database was
edited by hand and `kozane card list --sort` will report those cards as `1970` or
`invalid`.

The check names the cards it found, by short ID — up to five, then `and N more`:

```
  ✗  Card timestamps valid — 2 cards stamped outside what this app writes, likely inserted by hand: 6fd3a2b, 41c0e9d; kozane card list --sort reports them as 1970 or invalid
```

---

### `kozane doctor config`

Checks `.kozane/config.json` and reports every problem at once, unlike the commands that
read the config for real and stop at the first one.

```bash
kozane doctor config
kozane doctor config --strict
```

| Severity    | Reported for                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `✗` error   | unreadable file, invalid JSON, missing required key, invalid value                                                             |
| `⚠` warning | unknown key, with the nearest known key suggested when it looks like a typo, and two `ui.*Shortcut` keys bound to the same key |
| `ℹ` note    | unset optional keys, each listed with the default standing in for it                                                           |

Required: `name`, `taskspace.defaultDir`, `taskspace.searchRoots`. Optional: everything
under `server` and `ui`, each of which falls back to its built-in default.

Exit code `1` when there is at least one error, `0` otherwise. `--strict` makes warnings
fail too, for setups where an unknown key should break the build.

Output:

```
Config: /path/to/project/.kozane/config.json

  ✗  name is missing
  ✗  server.port must be between 0 and 65535 (found: 70000)
  ⚠  server.protocol is not a known key
  ⚠  ui.defaultFontSze is not a known key — did you mean "defaultFontSize"?
  ℹ  server: 1 of 2 keys not set — using defaults
       host: "127.0.0.1"
  ℹ  ui: 27 of 28 keys not set — using defaults
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
Taskspaces   : 3
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
2. Requires the database to be current, as every workspace command does (see below).
3. Inserts a `project` DB record → gets a stable UUID.
4. Creates a default "General" bundle and a default "Base" layer for the project.

Steps 3 and 4 are one transaction, so a project never exists without the bundle and layer
a canvas needs. The browser project list creates projects through the same routine.

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

Lists every scope in the workspace using collision-safe short IDs, followed by the projects
that scope reaches — through a card filed into it or a taskspace attached to it. A scope no
project has reached yet is shown as `(unused)`; those are visible from every board.

```bash
kozane scope list
kozane scope list --project <projectId>
```

`--project` narrows the list to what that project's board draws. Short IDs are always
computed against every scope in the workspace, so an ID printed here is the same one
whether or not the list was narrowed.

If no scopes exist, the command prints `No scopes found.`, or
`No scopes found in this project.` when `--project` was given.

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

Moves a layer one step up or down the stack. `<direction>` must be `up` or `down`. Moving
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

Project, bundle, and scope options accept full or short IDs, and `--layer` also accepts a
layer name. Without `--project`, the workspace default project is used. Without `--bundle`, that
project's default bundle is used. Without `--layer`, that project's default layer is used.
When `--scope` is provided, card creation and scope membership are committed in one
transaction.

Example:

```bash
kozane card add "Investigate caching" --project eb155d6 --scope e3ee90b --x 48 --y 72
```

---

### `kozane card squash [content]`

Splits text using a configurable JavaScript regular expression, trims each segment,
and adds every non-empty segment as a separate card. The default pattern splits on
`. ` (a period followed by a space), `。`, or a blank line, preserving dots inside
values such as `example.com`. Generated cards are placed on unoccupied grid positions
instead of being stacked at the same coordinates. Pass the text as an argument or pipe
it through standard input:

```bash
kozane card squash "First thought. 第二の考え。 Third thought."
cat foo.txt | kozane card squash
kozane card squash "one | two, three" --pattern '\s*[|,]\s*'
```

The command accepts `--pattern`, `--project`, `--bundle`, `--scope`, and `--layer`, using
full or short IDs. `--layer` also accepts a layer name. These options work with piped
input as well:

```bash
cat foo.txt | kozane card squash --project eb155d6 --scope e3ee90b
```

All generated cards and their optional scope memberships are committed in one
transaction, so an error does not leave a partially created set. Every generated card
is new, and is created and last-updated at the moment the command runs — the same moment
for all of them, so `kozane card list --sort created` never splits one command's cards
across a second.

---

### `kozane card show <cardId>`

Prints a card content by full or short ID. Line breaks are preserved.

```bash
kozane card show <cardId>
kozane card show 17b86d2
kozane card show 17b86d2 --times
```

`--times` prints the card's history above its text, as the three values
`kozane card list --sort` orders by, followed by a blank line:

```
created  2026-02-01T00:00:00Z
updated  2026-03-01T00:00:00Z
gap      28d

A card reconsidered a month later
```

Without the flag the output is the card's text and nothing else, so
`kozane card show <cardId> > card.txt` writes the card rather than the card and a header.
The same rules apply as in the listing: only a change to a card's text moves `updated`, and
a timestamp that names no moment reads `invalid`.

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
kozane card list [--project <projectId>] [--bundle <bundleId>] [--sort <key>] [--reverse]
kozane card list --taskspace <path> [--sort <key>] [--reverse]
```

When the current directory contains `.taskspace.json`, running `kozane card list`
without project or bundle options automatically uses that marker. The marker must be
in the current directory, and parent directories are not searched.

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

#### Sorting

Without `--sort`, cards are listed in the order the database returns them, which is not
an order the command promises to keep. `--sort <key>` takes one of three keys and applies
to every form of the command, the taskspace forms included:

| Key       | Order                                               |
| --------- | --------------------------------------------------- |
| `created` | Oldest card first.                                  |
| `updated` | Least recently rewritten first.                     |
| `gap`     | Shortest interval between the two timestamps first. |

Cards with equal values are ordered by ID. `--reverse` flips the whole listing, ties
included, and is refused without `--sort` — there is no defined order to reverse.

**Only a change to a card's text counts as updating it.** Moving a card across the board,
resizing it, restacking it, or moving it to another bundle or layer leaves both timestamps
as they were. So `gap` measures how long a card stood before it was rewritten, not how
recently it was rearranged; a card never edited since it was added has a gap of `0s`.

`--sort` adds the value it ordered by as a column between the position and the text: an
ISO timestamp to the second for `created` and `updated`, and the interval in its largest
whole unit for `gap` (`0s`, `45s`, `12m`, `3h`, `5d`). Without `--sort` the line is
unchanged.

The column goes before the text rather than after it because card text may contain
anything, trailing spaces included, so the end of the line is not a place another field
can be told apart from. A script that reads the card text as everything past the
coordinates must therefore account for the column when it passes `--sort`, or not pass it.

```bash
kozane card list --sort created
kozane card list --sort updated --reverse
kozane card list --sort gap
```

```
d981fa1  General  (0, 0)  0s  A card added and left alone
15a6537  General  (40, 0)  28d  A card reconsidered a month later
```

Cards created before this option existed carry the timestamp of the migration that added
the columns, so they read as never since edited until their text is next changed.

A card whose column holds a value no date can be read from prints `invalid` in place of the
timestamp or interval, and sorts after every card that does name a moment — first, rather
than last, under `--reverse`. The rest of the listing prints as it would have. Only
hand-written SQL can put such a value in the column, and `kozane doctor` reports it.

Both timestamps are read by the CLI only. The board is not sent them and cannot order or
display by them, and `kozane net ssg generate` output does not contain them.

A card whose timestamps were never written — which only a hand-written `INSERT INTO card`
naming neither column can produce — is reported by `kozane doctor` and lists as `1970`.

Squashing a card replaces it with one new card per piece, on the board and through
`kozane card squash` alike. The pieces are created when the squash ran, not when the text
was first written, so a card thought about for a month and then squashed leaves pieces that
read as created today with a gap of `0s` — all of them at the one moment, however many
pieces there were.

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

### `kozane tag list`

Lists every tag in a project as a tree, with how many cards and files each one gathers.

```bash
kozane tag list [--project <projectId>]
```

A count is of distinct cards and files, not of occurrences: a card written
`'perf:cache and 'perf` is one card under `'perf`. A parent's count includes everything
under it, so `'perf` counts what `'perf:cache` holds as well.

```bash
kozane tag list
'perf  1 card, 1 file
  'cache  1 card, 1 file
```

Taskspace files are read as part of this. A taskspace that could not be read in full is
named afterwards, in the same words the browser's tag index uses, so a tag missing from the
list is not read as a tag nobody wrote:

```
Note: notes was not read in full — some files were larger than the scan had budget left for (for example media/talk.mp4, logs/).
```

A path ending in `/` is a directory that could not be listed rather than a file of that name.

The gather is kept in `.kozane/tag-index.json`, so a second run does not re-query every card
and re-read every file to reach the answer the first one reached. Nothing is trusted from it
unchecked: card hits are used only while the database is byte-for-byte the one they came
from, and a file's tags only while that file's size and modification time are unchanged.
Anything else is gathered again. Deleting the file costs one slow run.

---

### `kozane tag show <tag>`

Lists the cards and taskspace files under a tag, subcategories included.

```bash
kozane tag show <tag> [--project <projectId>] [--no-files]
```

The tag may be given with or without its sigil — `kozane tag show perf` and
`kozane tag show \'perf` are the same request — because most shells eat an unescaped
apostrophe. `--no-files` lists cards alone and skips the disk walk entirely.

Each card row carries its short ID, the tags it matched by, and its text. Each file row
carries the path and line, the tags matched, and the line the tag sits on. A card found
under two tags is one row naming both.

File rows are grouped under the taskspace they were found in, because a path is relative to
one and says nothing on its own — a project draws its own taskspaces and every unplaced one,
so two `README.md`s in one listing is an ordinary workspace rather than an unusual one. The
browser's tag index heads its file rows the same way.

```bash
kozane tag show perf
Cards:
  4a6f1fb  'perf 'perf:cache  caching work 'perf:cache and 'perf
Files:
  notes:
    README.md:3  'perf:cache  See 'perf:cache for the plan.
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

States:

| Status    | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `current` | Every migration in the journal has been applied                             |
| `pending` | Newer migrations exist, so run `kozane db migrate`                          |
| `missing` | The database file does not exist                                            |
| `gapped`  | A migration older than the newest applied one was never applied or was lost |
| `unknown` | The migration metadata could not be read                                    |

A `gapped` database cannot be repaired by `kozane db migrate`, which only applies
migrations newer than the newest recorded one. Restore a backup instead.

---

### `kozane db migrate`

Backs up the database, then applies pending migrations.

```bash
kozane db migrate
```

Behavior:

1. Checks migration status and exits early if already current.
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
- Writes to `file` if given, otherwise prints to stdout.
- Writes export format version 6. Older files can still be imported: version 2
  (exported before projects had a default flag) comes back with every project
  non-default, version 3 (before layers) gets a rebuilt default layer per project,
  version 4 (before warps) comes back with no warps, and version 5 (before the
  card timestamps) comes back with every card created at the moment of the import
  and never since edited.

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
- Backs up the current database before overwriting it (best-effort, skipped if the file is corrupted).
- Copies the chosen backup over the live database.

Output:

```
Available backups:
  kozane.20240101T120000.db ← most recent

Current database backed up: .kozane/backups/kozane.20240101T130000.db
Restored: .kozane/backups/kozane.20240101T120000.db
```

---

### `kozane taskspace list`

Lists every taskspace in the workspace as `<id>  <name>  <project>  <scope>  <path>`, using
collision-safe short IDs. This is the workspace-wide view: a board draws only its own
project's taskspaces plus the unassigned ones, so a taskspace created from another project
is visible here and nowhere else.

```bash
kozane taskspace list
kozane taskspace list --project <projectId>
```

`--project` narrows the list to what that project's board draws, which includes taskspaces
with no project of their own. An em dash in the project or scope column is a real state
rather than missing data: an unassigned taskspace appears on every board, and an unscoped
one gathers no cards. Short IDs are always computed against every taskspace in the
workspace, so an ID printed here is the same one whether or not the list was narrowed.

If no taskspaces exist, the command prints `No taskspaces found.`, or
`No taskspaces found in this project.` when `--project` was given.

Unlike `kozane taskspace scan`, this reads only the database and never touches the
filesystem, so it reports what Kozane believes rather than what is on disk.

---

### `kozane taskspace scan`

Scans the filesystem for taskspaces and reports differences from the database. It is a
dry run by default. Pass `--apply` to write changes.

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
   - Path changed → reported as `moved`. With `--apply`, updates `path` and `lastSeenAt`.
   - DB record missing → reported as `orphan`. With `--apply --reattach`, inserts the record.
   - Marker missing for DB record → reported as `missing`. With `--apply --cleanup`, deletes the DB record.
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
kozane taskspace create <name> [--scope <scopeId>] [--no-scope]
                              [--project <projectId>] [--dir <path>]
```

Options:

| Flag                | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `--scope <scopeId>` | Attach taskspace to an existing scope                               |
| `--no-scope`        | Create without a scope (mutually exclusive with `--scope`)          |
| `--project <id>`    | Project to own it, required when the workspace has several projects |
| `--dir <path>`      | Target directory (default: `<projectRoot>/<name>`)                  |

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
    "defaultCardWidth": 210,
    "newCardPlacement": "vertical-list",
    "defaultZoom": 1,
    "zoomStep": 0.05,
    "leftPanelWidth": 216,
    "rightPanelWidth": 232,
    "defaultShowFooter": false,
    "defaultShowSidePanel": false,
    "defaultShowWarps": true,
    "editorVimMode": false,
    "warpMarkerSize": 20,
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
    "resizeCardShortcut": "r",
    "squashCardShortcut": "s",
    "deleteCardsShortcut": "Delete",
    "setWarpShortcut": "a",
    "toggleWarpsShortcut": "A",
    "removeWarpShortcut": "x",
    "canvasWidth": 5600,
    "canvasHeight": 4000,
    "contentMax": 10000
  }
}
```

Only `name` and the `taskspace` keys are required. `server` and `ui` fall back to their
built-in defaults key by key. Run [`kozane doctor config`](#kozane-doctor-config) after
editing this file by hand.

The default `"vertical-list"` stacks newly created cards downward in one non-overlapping
column. Set `ui.newCardPlacement` to `"grid"` for a compact four-column wrapping layout
with light overlap between cards.

Every `ui.*Shortcut` is compared against one `event.key`, so `"A"` means Shift+A. The four
arrow keys are reserved for moving between warps, and a shortcut bound to one is an
invalid value like any other. `kozane doctor config` reports it as an error, and the field
falls back to its default. Two shortcuts bound to the same key are kept, so both actions
still happen, and the pair is reported as a warning.

`ui.defaultCardWidth` is what a card is drawn at until it is resized on the board. A card
resized there keeps a width of its own and stops following the setting; every other card
goes on tracking it. Both are held to the same 40–1200 range.

`ui.canvasWidth` and `ui.canvasHeight` size the board, and every stored position is held
inside them. A card or a warp written past the edge is clamped to it, and the response
reports the position as stored rather than as sent.

`ui.contentMax` is how much text one card may hold, in characters, within a 100–1000000
range. Both writers enforce it: the card endpoints answer `400`, and `kozane card add`
and `kozane card squash` exit non-zero without writing anything. `card squash` holds each
segment to it separately and names the one that was too long. Raising it is not free —
the board's once-a-second poll carries every card's whole text.

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

The marker stores full UUIDs. Commands print the short form of the same IDs, `0d5878b`
and `aa414b7` above, and accept either.

The marker is the filesystem anchor. The database stores only the last-known path.
Renaming or moving the directory does not change the taskspace's identity, and
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
| `project_id`   | text FK → project   | nullable, cascade delete         |
| `scope_id`     | text FK → scope     | nullable, set null on delete     |
| `name`         | text                | display name                     |
| `path`         | text                | current known filesystem path    |
| `path_kind`    | text enum           | `project_relative` \| `absolute` |
| `last_seen_at` | integer (timestamp) | set by `taskspace scan`          |
| `created_at`   | integer (timestamp) | set on insert                    |
| `updated_at`   | integer (timestamp) | set on every update              |

---

## Collision handling (taskspace scan)

| Situation                                  | Behavior                                               |
| ------------------------------------------ | ------------------------------------------------------ |
| Marker found, DB record missing            | Reported as orphan, `--apply --reattach` re-links      |
| DB record exists, marker missing           | Reported as missing, `--apply --cleanup` deletes       |
| Same `taskspaceId` in multiple directories | Reported as duplicate, `kozane taskspace fork` planned |

---

## Implemented surface

```
CLI:
  kozane init
  kozane open
  kozane net ssg generate
  kozane net ssg preview
  kozane doctor
  kozane doctor config
  kozane status
  kozane api key generate
  kozane api key refresh
  kozane project list / create / delete / default
  kozane scope list [--project] / add / delete
  kozane layer list / add / rename / move / delete
  kozane card add / squash / show / list / layer / nearest
  kozane tag list / show
  kozane db status / migrate / export / import / restore
  kozane taskspace list [--project] / scan / create

UI (SvelteKit):
  project dashboard
  bundle list and filtering
  card creation, editing, gluing, and arranging
  layers
  warps, including the cross-project warp list
  scope builder
  taskspace creation
  tag index page

Filesystem:
  .taskspace.json marker
  taskspace directory creation
  static site export
```

## Planned

```
kozane export <scope-id>                # export scope cards to markdown
kozane taskspace repair <id> --path ... # rewrite missing marker after confirmation
kozane taskspace fork <dir>             # assign new id to a duplicate
kozane scope inspect
kozane card search
```
