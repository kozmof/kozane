# Kozane CLI reference

Start by adding cards. Use other structures only when you need them.
See the [README](../README.md) for installation and the
[browser UI handbook](../docs/browser-ui-handbook.md) for browser operations.

## Common behavior

Workspace commands find `.kozane/config.json` by walking up from the current
directory. Without a workspace, they exit 1 and suggest `kozane init`.

`namespace`, `partition`, `card`, `layer`, `scope`, `warp`, `tag`,
`inventory`, and `taskspace` require current migrations and use the active session database,
including a running `--memory` server. `status` also uses the session database
but permits pending migrations. Other commands open the on-disk database directly.
Migrations are applied only by `db migrate`, which creates a backup first.
For gapped history, use `db status` and `doctor` rather than migrating.
Errors print to stderr and exit 1.

Commands with `--namespace` normally use the workspace default when omitted.
Check command-specific requirements below. IDs accept full or unambiguous short
forms where documented. Layer arguments also accept names, with exact names preferred.

## Commands

### `kozane init`

Create `.kozane/config.json`, a migrated database, and the default `main` namespace with a
`General` partition and `Base` layer. The workspace name defaults to the directory name.
Refuses if `.kozane/` exists. The directory gets a `.gitignore` excluding its contents.

```bash
kozane init
```

### `kozane open`

Start the browser UI. Host and port use the first available value from flags, `KOZANE_HOST` /
`KOZANE_PORT`, config, then `127.0.0.1` / `17173`. Empty environment values are ignored.
Ports must be integers from 0 to 65535, with 0 requesting an available port. Invalid explicit
values fail.

Migrations must be current. `--memory` instead creates a temporary database with a `:memory:`
namespace. Workspace commands use that database while the server runs, and changes disappear
when it stops.

Refuse to start while the config still has the old `"defaultDir": "."`, as `kozane doctor`
fails on it, since the browser would otherwise create new taskspaces in the old layout. Print
the moves `kozane doctor --fix` would make for taskspace directories Kozane created where that
layout put them: at the workspace root, or in a namespace folder there. Other directories out
of place, such as after a namespace was renamed, do not stop it. See
[old taskspace layout](#old-taskspace-layout). `--memory` skips this check.

`--allow-remote` requires a generated API key. Non-loopback bindings also require
`--no-open` and HTTPS through a reverse proxy.
See the [Security matrix](../docs/security-matrix.md).

```bash
kozane open [--host <host>] [--port <port>] [--memory] [--log-requests]
            [--allow-remote] [--no-open]
```

| Flag             | Default     | Description                                        |
| ---------------- | ----------- | -------------------------------------------------- |
| `--host`         | `127.0.0.1` | Bind host (from config if unset)                   |
| `--port`         | `17173`     | Port number (from config if unset)                 |
| `--memory`       | false       | Use a fresh temporary database for this server run |
| `--log-requests` | false       | Log each HTTP request as structured JSON           |
| `--allow-remote` | false       | Serve through an HTTPS reverse proxy (see below)   |
| `--no-open`      | false       | Start server without opening the browser           |

### `kozane api key generate`

Generate and print a workspace API key. Store it in `.kozane/api.json` with owner-only
permissions. Once present, every HTTP request requires authentication. Refuses if a key exists.
Use `api key refresh` to replace it.

```bash
kozane api key generate
```

### `kozane api key refresh`

Replace and print the existing API key. The old key stops working immediately. Refuses if no
key exists.

```bash
kozane api key refresh
```

### `kozane net ssg generate`

Export a read-only workspace snapshot. The output directory is emptied and rewritten, including
a `.nojekyll` file for GitHub Pages. Requires current migrations and the source build
toolchain. Run from a cloned repository after `pnpm install`.

Scopes, taskspaces, and files are excluded unless `--include-scoped-files` is given. That
option publishes real contents of scoped taskspaces. See the
[Security matrix](../docs/security-matrix.md#static-export-ssg) for limits and exclusions.

```bash
kozane net ssg generate [--out <dir>] [--base <path>] [--include-scoped-files]
```

| Flag                     | Default   | Description                                                    |
| ------------------------ | --------- | -------------------------------------------------------------- |
| `--out <dir>`            | `./site`  | Output directory, emptied and rewritten on each run            |
| `--base <path>`          | site root | Base path when hosted under a subdirectory, e.g. `/kozane`     |
| `--include-scoped-files` | false     | Also export scopes, taskspace names, and a copy of their files |

### `kozane net ssg preview`

Serve an exported site over HTTP with GitHub Pages URL handling. Use the same `--base` as the
export. Refuses if the directory has no `index.html`.

```bash
kozane net ssg preview [--out <dir>] [--base <path>] [--host <host>] [--port <port>] [--no-open]
```

| Flag            | Default     | Description                                  |
| --------------- | ----------- | -------------------------------------------- |
| `--out <dir>`   | `./site`    | Directory to serve                           |
| `--base <path>` | site root   | Base path the site was built with            |
| `--host`        | `127.0.0.1` | Bind host (or `KOZANE_PREVIEW_HOST`)         |
| `--port`        | `17174`     | Port number (or `KOZANE_PREVIEW_PORT`)       |
| `--no-open`     | false       | Start the server without opening the browser |

### `kozane doctor`

Check workspace detection, config, database permissions, migrations, card timestamps, SQLite
integrity and references, workspace limits, inventory consistency, taskspace layout,
`taskspace.namespacePaths` keys, and port availability. Exit 0 when all checks pass, otherwise 1.

Database content checks require current migrations. Invalid timestamps, oversized text or
names, out-of-bounds cards, stored cards that overlap or are glued, and cards with only one of
`inventory_id` and `inventory_slot` set are reported with example IDs. Run `inventory repair`
for the last three. Limit checks use SQLite character counts, which can miss text that exceeds
the UTF-16 limit through astral characters.

For broken config, run `doctor config`. For database corruption, export readable data before
restoring a backup.

`--fix` first fixes the taskspace layout, then runs the checks. It refuses while Kozane is
running for the workspace.

```bash
kozane doctor [--fix]
```

| Flag    | Description                                                       |
| ------- | ----------------------------------------------------------------- |
| `--fix` | Move taskspace directories Kozane created into the current layout |

#### Old taskspace layout

Older versions put new taskspaces at `<root>/<name>` and wrote `"defaultDir": "."` to the
config. The layout check reports both:

- A config whose `taskspace.defaultDir` is `.` and that does not set `namespaceDirs`.
  `--fix` sets `defaultDir` to `taskspaces` and keeps the other keys.
- A taskspace directory whose marker says `ownsDirectory: true`, stored relative to the
  workspace, that is not where `taskspace create` would now put it. A legacy `defaultDir`
  counts as `taskspaces` here. `--fix` moves the directory, keeping its folder name, and
  updates the record.

Directories the user chose with `--dir` are never moved. Neither are taskspaces with no
namespace, directories outside the workspace, directories that hold another taskspace, or
ones whose target is outside the workspace, inside another taskspace that stays put, or under
an ambiguous `namespacePaths` key. Owned directories that are out of place but cannot move,
because they hold another taskspace or their target is outside the workspace or inside another
taskspace, are listed with the reason under "Taskspace directories Kozane cannot move". They do
not fail the check, since `--fix` cannot help, and they do not stop `defaultDir` from being
rewritten. Move them yourself, then run `kozane taskspace scan --apply`. A move whose target already exists is reported and skipped,
with what to do: move the entry at the target aside, or rename the directory and run
`kozane taskspace scan --apply`. Running `--fix` again retries it. A directory whose target is
inside it, such as a taskspace named `taskspaces` at the root, is moved aside first and then
into place. When a record cannot be updated after its directory moved, the directory is moved
back; if that fails too, the report says to run `kozane taskspace scan --apply`. `--fix` moves
the directories first and rewrites `defaultDir` only when every move succeeded, so until then
`kozane open` keeps refusing.

Renaming a namespace, changing `defaultDir` or `namespaceDirs`, or moving a taskspace to
another namespace also leaves its directory out of place. The check still passes and notes how
many directories `--fix` would move, and `kozane open` still starts. Only the old layout
fails the check.

To keep the old layout, set `"namespaceDirs": false`. With `"defaultDir": "."`, the
directories at `<root>/<name>` then count as in place.

### `kozane doctor config`

Report all config problems together. Errors include unreadable files, invalid JSON, missing
required keys, and invalid values. Warnings include unknown keys and duplicate shortcuts. Notes
list defaults for unset optional keys.

Required keys are `name` and `taskspace.searchRoots`. Exit 1 for
errors, otherwise 0. `--strict` also fails on warnings.

```bash
kozane doctor config
kozane doctor config --strict
```

### `kozane config open`

Edit `.kozane/config.json` in a browser form. Start a small server on `127.0.0.1`, print its
link, and open it. The link carries a token made fresh for each run. Every request must send
it, so other pages and other users on the machine cannot read or change the config. Press
Ctrl+C to stop the server.

The page groups settings by section and shows each setting's default and allowed range. Saving
applies only the fields you changed and keeps other keys, including unknown ones, as they are.
It uses the same checks as `doctor config`. Errors block the save, and warnings are shown but
do not. If the file changed on disk since the page loaded it, the save is refused so the other
edit is not lost.

A running `kozane open` server picks up saved changes on its own. Reload open boards to see UI
changes. `server.host` and `server.port` take effect the next time `kozane open` starts. The
page also opens when the config has errors, so they can be fixed there. A file that is not
valid JSON is shown read-only and must be fixed by hand.

```bash
kozane config open [--port <port>] [--no-open]
```

| Flag        | Default     | Description                              |
| ----------- | ----------- | ---------------------------------------- |
| `--port`    | a free port | Port number                              |
| `--no-open` | false       | Start server without opening the browser |

### `kozane status`

Show server state (stopped, persistent, or `:memory:`) and namespace, partition, card, scope,
and taskspace counts. While a memory server runs, counts use its session database. Works even
when migrations are not current.

```bash
kozane status
```

### `kozane namespace list`

List namespace short IDs and names, marking the default with `(default)`.

```bash
kozane namespace list
```

### `kozane namespace create <name>`

Create a namespace with its default `General` partition and `Base` layer in one transaction.
Print its short ID and name.

```bash
kozane namespace create <name>
```

### `kozane namespace default <id>`

Set the workspace default used when `--namespace` is omitted. Accepts full or short IDs. Alias
`namespace set-default <id>`.

```bash
kozane namespace default <id>
```

### `kozane namespace delete <id>`

Delete a namespace and its partitions, cards, layers, warps, scope frames, and taskspace
records. Keep scopes and taskspace directories. If needed, promote another namespace to
default. Accepts full or short IDs.

```bash
kozane namespace delete <id>
```

### `kozane partition list`

List partition short IDs and names, marking the default with `(default)`.

```bash
kozane partition list [--namespace <namespaceId>]
```

### `kozane partition add <name>`

Create a partition and print its short ID and name. Names are trimmed, non-empty, and unique
within the namespace.

```bash
kozane partition add <name> [--namespace <namespaceId>]
```

### `kozane partition delete <partitionId>`

Delete a partition and move its cards to the default partition. Refuses to delete the default.
Resolve full or short IDs within the selected namespace.

```bash
kozane partition delete <partitionId> [--namespace <namespaceId>]
```

### `kozane scope add <name>`

Create a cross-namespace scope and print its short ID and name. Names must be non-empty and
unique workspace-wide.

```bash
kozane scope add <name>
```

### `kozane scope list`

List every scope and the namespaces it reaches through cards or taskspaces. Unused scopes
appear as `(unused)` and are visible on every board. `--namespace` limits results to that
board, including unused scopes. Short IDs remain consistent across filtered listings.

```bash
kozane scope list
kozane scope list --namespace <namespaceId>
```

### `kozane scope add-cards <scopeId> <cardIds>`

Add cards to a scope. Cards must belong to the selected namespace. Existing membership is
unchanged. Print the number added and scope short ID.

```bash
kozane scope add-cards <scopeId> <cardIds...> [--namespace <namespaceId>]
kozane scope add-cards e3ee90b 3f9a2c1 72ac1f8
```

### `kozane scope remove-cards <scopeId> <cardIds>`

Remove scope membership without deleting cards. Cards must belong to the selected namespace.
Non-members are unchanged.

```bash
kozane scope remove-cards <scopeId> <cardIds...> [--namespace <namespaceId>]
```

### `kozane scope delete <id>`

Delete a scope workspace-wide by full or short ID. Remove memberships and leave attached
taskspaces unscoped. Keep cards.

```bash
kozane scope delete <id>
```

### `kozane layer list`

List layers bottom to top with short ID, position, card count, and name. Mark the default with
`(default)`.

```bash
kozane layer list [--namespace <namespaceId>]
```

### `kozane layer add <name>`

Create a layer on top and print its short ID, name, and position. Names must be non-empty and
unique within the namespace.

```bash
kozane layer add <name> [--namespace <namespaceId>]
```

### `kozane layer rename <layer> <name>`

Rename a layer. Layer arguments accept an exact name, full ID, or short ID. An exact name wins.

```bash
kozane layer rename <layer> <name> [--namespace <namespaceId>]
kozane layer rename Draft Sketches
```

### `kozane layer move <layer> <direction>`

Move a layer one step `up` or `down`. Moving beyond either end fails.

```bash
kozane layer move <layer> up|down [--namespace <namespaceId>]
kozane layer move Sketches down
```

### `kozane layer delete <layer>`

Delete a layer and move its cards to the default layer. Refuses to delete the default.

```bash
kozane layer delete <layer> [--namespace <namespaceId>]
```

### `kozane card add <content>`

Create a card. Omitted namespace, partition, and layer options use their defaults. IDs may be
full or short, and layers also accept names. Optional scope membership is committed with the
card.

Text is trimmed, must be non-empty, and must fit `ui.contentMax`.

```bash
kozane card add <content> [--namespace <namespaceId>] [--partition <partitionId>]
                          [--scope <scopeId>] [--layer <layer>]
                          [--x <number>] [--y <number>]
```

### `kozane card squash [content]`

Split argument or piped text into new cards, trimming segments and skipping empty ones. The
default separator is a period followed by whitespace, `。`, or a blank line. Dots in
`example.com` remain intact. Use `--pattern` for a JavaScript regular expression source.

The cards go into a new inventory in text order. The inventory is named `Squash N`, where N
is one more than the highest such number in the namespace. `--x` and `--y` place the
inventory and default to 0. `kozane inventory take` without `--x` and `--y` puts a card at a
free grid position near the inventory.

Accepts `--namespace`, `--partition`, `--scope`, and `--layer` with the same resolution as
`card add`. Creating the inventory, the cards, and scope membership is atomic. All pieces
share new creation and update timestamps, and each must fit `ui.contentMax`. The command
fails when the pieces do not fit in one inventory.

```bash
kozane card squash "First thought. 第二の考え。 Third thought."
cat foo.txt | kozane card squash
kozane card squash "one | two, three" --pattern '\s*[|,]\s*'
```

Apply the same options to piped text:

```bash
cat foo.txt | kozane card squash --namespace eb155d6 --scope e3ee90b
```

### `kozane card show <cardId>`

Print card text with line breaks preserved. Accepts full or short IDs. `--times` adds `created`,
`updated`, and `gap` values above the text. Without it, output is suitable for redirecting
to a text file. See [Sorting](#sorting) for timestamp rules.

```bash
kozane card show <cardId>
kozane card show 17b86d2
kozane card show 17b86d2 --times
```

### `kozane card layer <cardId> <layer>`

Move a card to a layer in its own namespace, stacking it above existing cards. Resolve the
namespace from the card. Accept full or short card IDs and layer names or IDs. Cross-namespace
layers are refused.

```bash
kozane card layer <cardId> <layer>
kozane card layer 3f9a2c1 Draft
```

### `kozane card edit <cardId> <content>`

Replace card text, preserving position and memberships. Text follows `card add` validation.
Identical text leaves the update timestamp unchanged.
A stored card whose new text reaches cells another card holds moves to the first place it
fits, and the command prints its new slot.

```bash
kozane card edit <cardId> <content>
kozane card edit 3f9a2c1 "Investigate caching, then measure"
```

### `kozane card delete <cardIds>`

Delete cards from one namespace, inferred from the first ID. Dissolve glue groups left with
fewer than two cards. Print the count and short IDs.

```bash
kozane card delete <cardIds...>
kozane card delete 3f9a2c1 72ac1f8
```

### `kozane card move <cardId>`

Move a card with at least one of `--x` or `--y`. Omitted axes stay unchanged. Positions accept
integers or relative offsets such as `current+120` and `current-48`. Clamp to canvas bounds
and print stored coordinates.

```bash
kozane card move <cardId> [--x <position>] [--y <position>]
kozane card move 3f9a2c1 --x 480 --y current+120
```

### `kozane card partition <partitionId> <cardIds>`

Move cards to a partition in their namespace. All cards must share that namespace. Preserve
positions, layers, and scopes.

```bash
kozane card partition <partitionId> <cardIds...>
kozane card partition 72ac1f8 3f9a2c1 e3ee90b
```

### `kozane card namespace <namespaceId> <cardIds>`

Move cards from one source namespace to another. Match partitions and layers by name, creating
missing ones. Leave glue groups and drop direct taskspace links belonging to other namespaces.
Stack moved cards above existing destination cards while preserving their relative order.

```bash
kozane card namespace <namespaceId> <cardIds...>
kozane card namespace eb155d6 3f9a2c1
```

### `kozane card list`

List namespace cards or cards associated with a taskspace. `--taskspace` accepts a directory or
its `.taskspace.json` and cannot combine with `--namespace` or `--partition`.

Without namespace or partition options, a marker in the current directory is used
automatically. Parent directories are not searched for taskspace markers. Scoped taskspaces
list current scope members. Unscoped taskspaces print a notice and list directly associated
cards.

```bash
kozane card list [--namespace <namespaceId>] [--partition <partitionId>] [--sort <key>] [--reverse]
kozane card list --taskspace <path> [--sort <key>] [--reverse]
```

#### Sorting

Use `--sort created` (oldest first), `--sort updated` (least recently edited
first), or `--sort gap` (shortest interval between creation and edit first).
Ties sort by ID. `--reverse` reverses the whole order and requires `--sort`.
Without sorting, order is unspecified.

Sorting adds a column before the text. Creation and update values are ISO timestamps
to the second. Gaps use the largest whole unit, such as `45s`, `12m`, or `5d`.
Only text changes update timestamps. New cards have a zero gap, including squash
results, which share the time of creation. Cards predating timestamp support use
the migration time until edited.

Invalid dates print `invalid` and sort last, or first with `--reverse`.
Unwritten timestamps print as `1970`. Run `doctor` to locate them.
Timestamps are available through the CLI, not the board or static export.

### `kozane card nearest <cardId>`

List cards in the given card's namespace by Euclidean distance. The given card appears first at
`0.00`, with ties ordered by ID. Rows include short ID, partition, position, distance, and
text.

```bash
kozane card nearest <cardId>
kozane card nearest 17b86d2
```

### `kozane card glue <cardIds>`

Group cards from one namespace so they select and move together. By default, only named cards
join, leaving previous groups. `--add` includes every member of the groups touched, allowing
groups to merge.

`--align-list` arranges the final group vertically from the first card, using argument order
and estimated card heights. Coordinates are clamped to canvas bounds. Combines with `--add`.
Print the group ID, card IDs, count, and active options.

```bash
kozane card glue <cardIds...> [--add] [--align-list]
kozane card glue 3f9a2c1 72ac1f8
```

### `kozane card unglue <cardIds>`

Remove cards from glue groups without changing their content or placement. All cards must share
a namespace. Dissolve groups left with fewer than two members. Unglued cards are unchanged.

```bash
kozane card unglue <cardIds...>
```

### `kozane warp list`

List warps in creation order with short ID, number, and position.

```bash
kozane warp list [--namespace <namespaceId>]
```

### `kozane warp add`

Create a saved canvas position. Clamp coordinates to canvas bounds and print the stored
position and short ID. Warps have numbers in creation order, not names.

```bash
kozane warp add [--namespace <namespaceId>] [--x <number>] [--y <number>]
kozane warp add --x 1200 --y 800
```

### `kozane warp delete <warpId>`

Delete a warp by full or short ID within the selected namespace. Later warps are renumbered.

```bash
kozane warp delete <warpId> [--namespace <namespaceId>]
```

### `kozane inventory list`

List inventories in creation order with short ID, name, icon position, and card count.

```bash
kozane inventory list [--namespace <namespaceId>]
```

### `kozane inventory add`

Create an inventory icon at a canvas position. Clamp coordinates to canvas bounds and
print the stored position and short ID. The name is optional.

```bash
kozane inventory add [--namespace <namespaceId>] [--name <name>] --x <number> --y <number>
kozane inventory add --name Later --x 1200 --y 800
```

### `kozane inventory show <inventoryId>`

List the cards in an inventory by slot, with the rows each covers, its column, short card
ID, and the first line of text. Slots count from 0, six to a row. A card covers as many
rows as its text needs.

```bash
kozane inventory show <inventoryId> [--namespace <namespaceId>]
```

### `kozane inventory rename <inventoryId> <name>`

Rename an inventory. An empty name leaves it unnamed.

```bash
kozane inventory rename <inventoryId> <name> [--namespace <namespaceId>]
```

### `kozane inventory delete <inventoryId>`

Delete an inventory. Its cards return to the canvas at the positions they had before they
were stored.

```bash
kozane inventory delete <inventoryId> [--namespace <namespaceId>]
```

### `kozane inventory put <inventoryId> <cardIds>`

Store cards in an inventory of their namespace. Each card goes to the first place it fits,
from `--slot` or from 0. A single card with `--slot` takes that slot, and the cards in the
way swap with it or move to the first place they fit. Stored cards leave their glue groups.

```bash
kozane inventory put <inventoryId> <cardIds...> [--slot <number>]
```

### `kozane inventory take <cardIds>`

Return stored cards to the canvas where they were before they were stored. `--x` and
`--y` place a single card somewhere else instead.

```bash
kozane inventory take <cardIds...> [--x <number> --y <number>]
```

### `kozane inventory repair`

Move stored cards that overlap apart, take stored cards out of glue groups, and put cards with
only one inventory column set back on the canvas, in every inventory of the workspace. A card
stays in its slot if it still fits, and otherwise moves to the first free place after it. A
card's height in the grid comes from its text, so an upgrade that changes the grid layout, or
an imported dump, can leave cards overlapping. Any write to an inventory repairs it first, and
`kozane db import` repairs every inventory after it imports. Run this to clear what `kozane
doctor` reports without waiting for either.

```bash
kozane inventory repair
```

### `kozane tag list`

List namespace tags as a tree with distinct card and file counts. Parent counts include
descendants. Taskspace files are included.

Notices identify incomplete scans and unavailable directories. A path ending in `/` identifies
a directory. Run `kozane taskspace scan --apply --cleanup` to reconcile moved or missing
taskspaces.

Results are cached in `.kozane/tag-index.json` and validated before reuse. See
[Cache behavior](../docs/cache.md) for refresh and cleanup.

```bash
kozane tag list [--namespace <namespaceId>]
```

### `kozane tag show <tag>`

List matching cards and taskspace files, including child tags. Accept tags with or without the
leading colon. `--no-files` lists cards only and skips file scanning.

Card rows include short ID, matched tags, and text. File rows are grouped by taskspace and
include path, line number, matched tags, and line text. Multiple matching tags share one row.
Results are capped at 200 card hits and 200 file hits, with notices when shortened.

```bash
kozane tag show <tag> [--namespace <namespaceId>] [--no-files]
```

### `kozane db status`

Report migration status and exit 0 only when current.

| Status    | Meaning                                         |
| --------- | ----------------------------------------------- |
| `current` | All journal migrations applied                  |
| `pending` | Run `kozane db migrate`                         |
| `missing` | Database file absent                            |
| `gapped`  | An older migration is missing, restore a backup |
| `unknown` | Migration metadata unreadable                   |

```bash
kozane db status
```

### `kozane db migrate`

Back up to `.kozane/backups/`, apply pending migrations, and report status. No changes when
already current. Refuses missing, unknown, or gapped databases and refuses while the workspace
server runs.

```bash
kozane db migrate
```

### `kozane db export [file]`

Export database data as JSON to a file or stdout. Requires current migrations. `--compact`
removes formatting. Writes format version 8. Import also accepts version 7, which has no scope
frames.

Older formats use `project` and `bundle` tables and are refused. Import them with Kozane 0.10
or earlier, then migrate.

```bash
kozane db export [file] [--compact]
```

### `kozane db import <file>`

Import an exported JSON file. Requires current migrations and `--force` when the database is
non-empty. Back up first, validate foreign keys before writing, and print per-table counts.

Taskspace paths must stay inside the workspace. Taskspaces with absolute paths are refused
unless `--allow-absolute-paths` is passed, because the board reads and writes files in those
directories.

Rows exceeding text, canvas, or name limits are imported with warnings so backups from
different settings remain restorable. Shorten oversized text, move out-of-bounds cards, or
adjust settings before editing. `kozane doctor` reports these rows afterward. Stored cards
that overlap are moved apart after the import, as `kozane inventory repair` does.

```bash
kozane db import <file> [--force] [--allow-absolute-paths]
```

### `kozane db restore [file]`

Restore a database backup. Without a file, list `.kozane/backups/` and use the latest. First
attempt to back up the current database, skipping that backup if corruption prevents it.

```bash
kozane db restore [file]
```

### `kozane taskspace list`

List database records as short ID, name, namespace, scope, and path. Does not inspect disk.
`--namespace` limits results to that board, including unassigned taskspaces. Short IDs remain
consistent across filtered listings. A dash means no namespace or scope.

```bash
kozane taskspace list
kozane taskspace list --namespace <namespaceId>
```

### `kozane taskspace scan`

Scan `taskspace.searchRoots` for `.taskspace.json` markers and compare them with database
records. Default is a dry run.

With `--apply`, update moved paths and matched records' last-seen times. Add `--reattach` to
insert orphan records and `--cleanup` to delete records whose markers are missing. Both require
`--apply`. If duplicate markers share an ID, the last directory found wins.

A reattached taskspace joins the namespace its marker names. When that namespace has been
deleted, it joins the workspace default instead, and the marker is updated to match.
`--namespace <id>` puts every reattached taskspace in that namespace instead. The directory
stays where it is. An orphan that cannot be reattached, such as one whose namespace is gone
when no namespace is left, is reported and skipped, the rest are still reattached, and the
command exits 1.

```bash
kozane taskspace scan [--apply] [--reattach [--namespace <namespaceId>]] [--cleanup]
```

| Flag               | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| `--apply`          | Write changes to the database (required by `--reattach` and `--cleanup`)        |
| `--reattach`       | Re-link orphan taskspaces found on disk but missing from DB (needs `--apply`)   |
| `--cleanup`        | Delete DB records for taskspaces whose marker file is missing (needs `--apply`) |
| `--namespace <id>` | Namespace for reattached taskspaces (needs `--reattach`)                        |

### `kozane taskspace create <name>`

Create a database record, target directory, and `.taskspace.json` identity marker. Require
either `--scope` or `--no-scope`.

Without `--dir`, use `<workspaceRoot>/<taskspace.defaultDir>/<namespace>/<name>`, where
`<namespace>` is the owning namespace's name. With the defaults, that is
`<workspaceRoot>/taskspaces/<namespace>/<name>`. Set `taskspace.namespaceDirs` to `false` to
leave out the namespace folder.

`namespaceDirs` defaults to `true` even in a config written before the key existed. A
workspace whose config sets `defaultDir` but not `namespaceDirs` therefore puts its new
taskspaces in namespace folders from now on. With `"defaultDir": "."`, those folders are
created at the workspace root. Existing taskspaces stay where they are. Set
`"namespaceDirs": false` to keep the old layout.

In the folder name, the namespace name is put in Unicode NFC form, and characters not
allowed in file names (`/ \ : * ? " < > |` and control characters) become `-`. Leading dots
and trailing dots and spaces are dropped. Each run of spaces inside the name becomes one `-`,
so `My Project` becomes `My-Project`. Names are cut to 60 characters, and to 221 UTF-8
bytes so a short-ID suffix still fits in 255. A name Windows
reserves, such as `CON` or `con.txt`, gets a `-` after its base name: `CON-`, `con-.txt`. A
name with nothing left uses the namespace ID. When two namespaces would get the same folder,
ignoring case, the oldest keeps it and the others get their short ID added, such as
`work-5c3d9e1`.

Folder names are worked out from the current namespaces each time. Renaming a namespace, or
deleting the older of two whose names clashed, changes the folder that later taskspaces go
in. Directories made in the old folder are not moved. They keep working, but rename and
delete from the browser leave them on disk.

To choose the directory for one namespace, add it to `taskspace.namespacePaths`. Its new
taskspaces then go to `<that path>/<name>`, with no namespace folder added, whatever
`defaultDir` and `namespaceDirs` say. Keys are namespace IDs, either the short ID
`kozane namespace list` prints, at least 7 characters, or the full ID, matched as
`--namespace` matches them. `kozane doctor` fails for a key that matches no namespace, such
as a typo or a deleted namespace, or more than one. The
longest matching key wins. A key that matches more than one namespace stops the create with an error naming
the full ID to use instead. Paths are relative to the workspace root or absolute. A path
outside the workspace root works here, but the browser refuses to create taskspaces there.

```json
"namespacePaths": {
  "aa414b7": "clients/acme",
  "5c3d9e1": "/srv/shared/kozane"
}
```

The taskspace name must then be one path segment, contain no `/`, `\`, or NUL, not start
with a dot, and not start or end with whitespace.
With `--dir`, the name is only a label. Store internal paths relative to the workspace and
external paths as absolute.

Without `--dir`, the create is refused when the target would sit inside another taskspace's
directory, such as a taskspace made with `namespaceDirs` off whose name matches a namespace
folder, since deleting that taskspace would delete the new one too. Inside the workspace this
is decided by the `.taskspace.json` markers on disk. For a target outside it, such as with an
absolute `defaultDir`, it is decided by the taskspace records. It is also refused when a
parent folder inside the workspace is a symlink that leads outside it or nowhere.

```bash
kozane taskspace create <name> [--scope <scopeId>] [--no-scope]
                              [--namespace <namespaceId>] [--dir <path>]
```

| Flag                | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `--scope <scopeId>` | Attach taskspace to an existing scope                      |
| `--no-scope`        | Create without a scope (mutually exclusive with `--scope`) |
| `--namespace <id>`  | Owning namespace (defaults to the workspace default)       |
| `--dir <path>`      | Target directory (default: see above)                      |

## Config file

Edit `.kozane/config.json` with `kozane config open`, or edit it by hand and run
`kozane doctor config`.
Only `name` and `taskspace.searchRoots` are required.
Other keys fall back to built-in defaults individually.

```json
{
  "name": "my-namespace",
  "server": {
    "host": "127.0.0.1",
    "port": 17173
  },
  "taskspace": {
    "defaultDir": "taskspaces",
    "namespaceDirs": true,
    "namespacePaths": {},
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
    "defaultShowFooter": false,
    "defaultShowSidePanel": false,
    "defaultShowWarps": true,
    "showZoomControl": true,
    "showLayerControl": true,
    "showScopeControl": true,
    "showSidePanelToggle": true,
    "editorVimMode": false,
    "editorAutoSave": true,
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
    "openFilePaletteShortcut": "e",
    "openFileBrowserShortcut": "o",
    "setWarpShortcut": "a",
    "toggleWarpsShortcut": "A",
    "removeWarpShortcut": "x",
    "addInventoryShortcut": "v",
    "canvasWidth": 5600,
    "canvasHeight": 4000,
    "contentMax": 200000
  }
}
```

- `newCardPlacement` accepts `vertical-list` or a four-column `grid`.
- Shortcuts match one `event.key`. `A` means Shift+A. Arrow keys are reserved
  for warps. Invalid bindings fall back to defaults. Duplicate bindings run both
  actions and produce a config warning.
- `defaultCardWidth` applies to cards without individual widths. Both widths
  range from 40 to 1200 pixels.
- `canvasWidth` and `canvasHeight` bound stored card and warp coordinates.
  Commands clamp positions and report the stored values.
- `contentMax` ranges from 100 to 1000000 UTF-16 code units. Each squash segment
  is checked separately. Raising it increases live-sync payload size.
- The HTTP body limit allows the larger of `contentMax` and the 16 MiB editor file limit at startup, including JSON escaping. Override with
  `BODY_SIZE_LIMIT`, using values such as `512K` or `2M`.

## Taskspace marker

Each taskspace directory has a `.taskspace.json` identity marker with full UUIDs.
Moving the directory preserves identity. Run `kozane taskspace scan --apply`
to update its recorded path.

```json
{
  "kind": "kozane.taskspace",
  "version": 2,
  "taskspaceId": "019dddef-87e3-7127-b5c9-0d5878bbf826",
  "namespaceId": "019dddef-87e3-7000-ac4d-aa414b7e75d7",
  "ownsDirectory": true
}
```

`ownsDirectory` is present only when Kozane created the directory in
`taskspace.defaultDir`, either from the browser or with `taskspace create`
without `--dir`. The browser renames and deletes only such directories along
with their taskspace.
