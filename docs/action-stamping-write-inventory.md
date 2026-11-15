# Action stamping write inventory

Stamping is not active. This inventory records write paths and contract gaps
for action stamping and restoration. Keep capture guards disabled until the
adapter prototype and restoration checks pass. Track progress in the
[task list](action-stamping-tasks.md).

## Contract declarations

`packages/core/src/actions/contracts.ts` declares version 1 invocation types for
all client writes and the existing namespace and scope administration operations.
Each envelope includes `args` for route and target values and `body` when the
operation accepts input. Transport options such as `keepalive` are not invocation
arguments. `scopes.create` retains the client's namespace argument even though
the underlying core service creates a workspace-wide scope.

The client classification is checked against these declarations during its build.
A client method declared as a write must have a core action kind. The focused
contract test checks this correspondence at runtime too.

`actions/invocation.ts` checks each envelope's complete routing arguments and body
presence before dispatch. It copies JSON-compatible input without applying domain
normalization. Service validation still owns content limits and resolved values.

`actions/registry.ts` requires replay handlers for syncable declarations and explicit
recovery handlers for local-only declarations. Registry selection checks the recorded
contract version against supported schema versions and returns
`action-contract-required` without entering a handler on incompatibility. Registry
descriptors and schema support are copied so callers cannot replace them afterward.
Intent replay requires a replay binding provider and cannot invoke file recovery.

The [execution scope](action-execution-scopes.md) now provides an opt-in root
transaction, sequential child dispatch, handler ownership and a failure latch.
Core `InTx` services share that latch, including failures before SQL.

The [composition API](action-composition.md) now defines `system.compose` with
registered read helpers, a sequential dispatcher and serialized direct child
envelopes. Replay interprets the frozen list without rerunning the callback.

Production handler installation, system import, repair, config and taskspace
observation envelopes remain pending. Contract version persistence and
group dispatch integration also remain pending. Do not submit work based only on
a declaration's sync classification.

Taskspace lifecycle and file methods are declared local-only while their current
handlers still combine filesystem work and shared rows. Before activation, split
lifecycle handlers into syncable shared changes and separate local operations.
Local-only handlers must then be prevented from changing shared rows.

## Service and record writes

All paths below are relative to `packages/core/src`. Record methods exported from
`database.records` can also be called without services. Their mutation boundaries
must be covered before mandatory guards are enabled. Application modules in
`packages/kozane/src/db/api` and `packages/kozane/src/services` forward to core.

| Family | Service entry points | Record writes and indirect effects | Boundary work |
| --- | --- | --- | --- |
| Cards | `services/cards.ts` create, update, positions, remove, removeOne, move, layer, partition, stacking, squash | `api/card/{create,update,case-update,stacking,placement}.ts` and `api/composite/{cards,move,squash}.ts`. Includes glue cleanup, scope membership, inventory refits and split card creation | All listed service writes expose `InTx` variants, including stacking and squash. Production action attribution remains pending |
| Glues | `services/glues.ts` create, remove | `api/glue.ts` creates glue IDs, replaces memberships and dissolves orphan groups | Existing transaction and `InTx` helpers need current-action attribution |
| Layers | `services/layers.ts` create, rename, remove, reorder | `api/layer.ts`, `api/composite/reassign.ts`. Remove moves cards to the default layer | All listed service writes expose `InTx` variants. Removal reuses the caller's transaction for card reassignment. Action attribution remains pending |
| Partitions | `services/partitions.ts` create, rename, remove | `api/partition.ts`, `api/composite/reassign.ts`. Service removal moves cards to the default partition. The separate low-level cascading delete can delete cards | All listed service writes expose `InTx` variants. Attribute reassignment and raw cascading deletion |
| Scopes | `services/scopes.ts` create, rename, remove, addMembers, removeMembers, createArea, updateArea, removeArea, removeWorkspace | `api/{scope,scope-rel,scope-area}.ts`. Board removal differs from workspace deletion. Scope deletion can clear taskspace references and delete relations and areas | All listed service writes expose `InTx` variants, including board removal. Action attribution remains pending |
| Warps | `services/warps.ts` create, update, remove | `api/warp.ts` | Existing transaction and `InTx` helpers need attribution |
| Inventories | `services/inventories.ts` create, update, remove, stow, take, repair | `api/inventory/{rows,stow,slots,repair}.ts`. Moves other cards' slots, refits widths and clears placement on removal | Wrap repair as an explicit system action and keep every slot shift in its root |
| Namespaces | `services/namespaces.ts` create, rename, remove, setDefault; administration also calls records | `api/namespace.ts` add, create, rename, setDefault, delete. Creation adds default partition and layer. Deletion cascades and dissolves surviving orphan glue groups | All listed service writes expose `InTx` variants. Low-level add and rename still accept DB handles. Action attribution remains pending |
| Taskspaces | Node handlers described below | `api/taskspace.ts` add, update, delete. Delete clears `card.taskspace_id` | Direct writes and local/shared storage split are pending |

`services/snapshot.ts`, tags, map and warp-directory expose reads. Derived tag
indexes are rebuilt and are not stamped application tables.

## CLI, HTTP and filesystem paths

| Entry | Current behavior | Required action boundary |
| --- | --- | --- |
| HTTP routes in `packages/kozane/src/routes` | Dispatch to resource services or Node taskspace handlers | Capture route IDs before validation. Attribute the full service invocation |
| CLI card, glue, layer, inventory, scope and warp commands | Many use `composeWrite` to resolve short IDs and call `InTx` services. Some callbacks call low-level helpers | Resolve replayable references and serialize ordered dispatcher children, or replace callbacks with named handlers |
| CLI namespace commands | Create/default use services. Delete calls `deleteNamespaceInTx` inside `withImageDeletion` | Register namespace administration and preserve image history protection |
| CLI taskspace scan, prune and create in `cli/commands/taskspace.ts` | Scan directly updates timestamps and paths or inserts rows. Prune directly deletes rows. Create also calls filesystem claim code | Separate local observations from shared identity/placement changes. Move `path`, `path_kind`, `last_seen_at` to local metadata |
| `lib/server/taskspace-service/{create,claim,mutate}.ts` | Create, rename and remove combine disk work and taskspace records. Rename may move a directory | Split shared label changes and local directory changes. Record external effects durably |
| `lib/server/taskspace-service/{file,files}.ts` and `taskspace-files.ts` | File create/save, directory create, entry rename/remove mutate disk | Local-only operations with recovery records. Include paths and intended content hashes |
| `cli/lib/db-json/import.ts` | Validates dump, opens DB, deletes rows in reverse table order and inserts rows inside `withTx` | `system.import` must retain original input and bind missing timestamps. Exact restoration needs a separate path |
| `cli/commands/init.ts` | Creates config, migrates, then seeds a default namespace, partition and layer | Run migration/initialization before baseline activation, with restartable progress |
| `cli/commands/config.ts`, workspace config and config-editor handlers | Write config files | Local-only records and file recovery where needed |
| `lib/server/image-assets.ts` and upload route | Writes UUID-named image files. Deletion wrappers and cleanup remove unused images | Reserve names with staging pins, then commit references/manifests and transfer protection atomically |
| `packages/core/src/migrations/apply.ts` and Node migration hooks | Driver-owned batch applies SQL and migration history | Trusted migrate mode and durable transition gate before capture activation |
| Database JSON export, DB backup/restore and standalone restoration harness | Export/read snapshots or replace database files | Keep exact recovery distinct from import, preserve local metadata and verify complete recovery bookkeeping |

The current `cli/lib/db-json/import.ts` does not call inventory repair. The design's
current-state summary says it does. Preserve current import behavior until its
explicit action contract is implemented. Likewise, service partition removal
currently reassigns cards rather than deleting them. Test cascading deletes
through the low-level path separately.

## Allocations, clocks and conflict modes

| Location | Existing source | Replacement before stamping |
| --- | --- | --- |
| `schema.ts` | UUIDv7 `$defaultFn` for namespace, partition, layer, scope, scope_area, warp, inventory, taskspace, card and glue | Supply IDs explicitly through stable action binding paths |
| `schema.ts` | `new Date()` defaults for taskspace and card timestamps | Explicit bound clock readings before SQL execution |
| `api/card/create.ts` `newCardStamps` | One `new Date()` for creation timestamps, shared by batch inserts | Bind creation time at the handler's stable invocation path |
| `api/card/update.ts` | `Math.floor(Date.now() / 1000)` used in conditional text update SQL | Bind the clock before the update, preserve unchanged-text behavior |
| `api/taskspace.ts` | `new Date()` on updates | Bind shared changes, isolate local observations |
| CLI taskspace scan/create | `Date.now()` and `new Date()` | Local observation records and bindings where replay/recovery needs them |
| `drizzle/0011_card_timestamps.sql` | Migration-time `unixepoch()` backfill | Allowed only during migration before baseline capture |
| `drizzle/0005_layer.sql` | SQL random UUID backfill | Allowed only during migration before baseline capture |
| `drizzle/0019_card_guards.sql` | `card_stamp_missing_timestamps` calls `unixepoch()` after insert | Replace with record-mode validation in a new migration. Bind import defaults and bypass validation in trusted restore mode |
| `api/scope-rel.ts` | Membership creation | Existence checks now run in the same write transaction as ordinary inserts. Duplicate inputs are deduplicated before batching |
| `api/composite/squash.ts` | Inherited scope relations for newly created cards | Ordinary inserts now run inside the squash transaction. Newly created card IDs cannot already have memberships |
| Image upload in `lib/server/image-assets.ts` | `randomUUID()` for filenames | Durable staging name reservation outside the DB data transaction |

The core lint rules now prohibit `onConflictDoNothing`. Membership idempotency
uses existence checks, and tests verify that duplicate requests never reach
`BEFORE INSERT` capture. A failure in a later batch rolls back earlier inserts
and their captured attempts.

The inspected runtime core writes contain no `INSERT OR IGNORE` or
`RAISE(IGNORE)`. Migration copies and generated SQL remain a separate audit
surface. The `strftime(..., 'unixepoch')` in card reads converts stored dates
and does not read the wall clock. Export timestamps and cleanup timers are not
application-row timestamps.

`actions/bindings.ts` now supplies entity IDs, child IDs and integer clock values
from injected sources during recording. Replay copies the recorded map, permits
skipped bindings and refuses unbound paths or type changes. Snapshots preserve
unused bindings. Path keys encode tuples so separators in entity IDs cannot
collide. The execution scope adds hierarchical child paths and handler-scoped
allocation paths. Replay preserves the original map while recording the actual
child envelopes and entry order for that run. `actions/allocations.ts` now binds
generated IDs in the namespace, partition, layer, scope, scope-area, warp,
inventory, glue and card record helpers when called through a guarded action
handle. Single and batch card creation bind timestamps before insertion. Card
text updates bind their SQL clock while retaining the unchanged-text comparison.
Batch IDs use original input indexes before SQL chunking. Other IDs use table
roles within the owning handler's stable invocation path. See
[allocation keys](action-execution-scopes.md#invocations-and-allocations).

Squash now reuses its caller's transaction. Its inventory, piece IDs and shared
creation timestamp bind to the source card ID and segment roles. Replaying fewer
segments preserves unused bindings. Requiring an extra segment or a different
source refuses replay without extending the map. Layout and inventory naming
still resolve against the current rows.

Ordinary handles retain existing defaults. Production handler installation,
taskspace allocations and raw ORM inserts remain pending. The migration 0019
timestamp fallback remains unchanged and must be replaced before activation.
`actions/import-timestamps.ts` resolves missing or zero creation
timestamps through a binding keyed by the imported card ID. A missing or zero
update timestamp follows creation time. Supplied nonzero timestamps and the
original input remain unchanged. The resolver is not yet connected to CLI import
and must never be used for exact restoration. Use epoch seconds when binding
SQLite timestamps. Do not use query result positions to identify allocations.

## Tables, triggers and adapter gate

Application tables are `namespace`, `scope`, `scope_area`, `partition`, `layer`,
`warp`, `inventory`, `taskspace`, `card`, `glue`, `glue_rel` and `scope_rel`.
All have a single `id` primary key except `glue_rel`, whose key is `card_id`,
and `scope_rel`, whose complete key is `(scope_id, card_id)`.

Migration 0019 adds two validating `BEFORE` triggers for inventory placement.
Its mutating triggers run `AFTER` and clear inventory slots or fill timestamps.
Capture must observe the slot-clearing update and all foreign-key cascade/set-null
writes. Replace the timestamp fallback before activation. Gate mutating triggers
out of trusted restore mode without disabling write guards.

The Node/libsql setup, WASM parity adapter and browser restoration worker now use
`configureActionConnection` to enable and verify `foreign_keys` and
`recursive_triggers`. Each opt-in action transaction repeats configuration before
entering handlers and verifies both flags after its completion hook. This covers
recycled libsql connections. Disabled foreign keys refuse entry because SQLite
cannot enable them inside an open transaction. Libsql and Node WASM regression
tests pass. Browser runtime verification remains pending.

The [capture prototype](action-capture-prototype.md) passes persistent `BEFORE`
capture, projection reconstruction and lossless installation checks on libsql and
Node WASM. Browser verification remains pending because Chromium was unavailable
and its download was denied by the environment's network policy. Keep production
log tables and activation gated on that verification. Existing JSON export values
cannot serve as the row codec.

## Tagged row codec

`actions/row-codec.ts` implements encoding version 1 for SQL NULL, signed 64-bit
INTEGER, finite REAL, Unicode TEXT and BLOB values. INTEGER encoding accepts
`bigint` and decoding returns `bigint`. REAL encoding preserves the full binary64
bit pattern, including signed zero. TEXT preserves embedded NUL and is not
normalized. Unpaired surrogates are rejected. BLOB encoding uses lowercase hexadecimal bytes.

Row comparison includes every column, storage class and REAL bit pattern while
ignoring object property order. Projection key encoding sorts primary-key column
names. Malformed tags, noncanonical values, unknown encoding versions and accessors
are rejected. Rows and tagged values are copied and frozen.

Unit tests cover JSON transport, both signed 64-bit limits, integers beyond the
JavaScript safe range, subnormal REAL values, Unicode, embedded NUL and empty blobs.
The codec requires actual SQLite storage classes and uncoerced values from the
adapter. The capture prototype supplies SQL encoding and installation expressions
and verifies full read-back equality on libsql and Node WASM. Browser support and
production integration still need verification.
