# Action execution scopes

The internal execution scope provides one rollback boundary for a root and its
children. It is opt-in and does not activate stamping on application databases.
Production log tables, application routing and guard activation remain pending.

## Dispatch real service actions

`actions/service-registry.ts` provides `createServiceActionRegistryV1`.
It installs handlers for every declared syncable database service kind and
the built-in `system.compose` interpreter. Each database handler forwards its
complete routing arguments and body to the corresponding `InTx` service.
The registry currently supports schema 19 only.

Supply a complete `LocalRecoveryHandlersV1` map when constructing the registry.
Missing handlers, wrong handler roles, unknown kinds and attempts to replace a
database handler are refused. Local-only kinds remain excluded from recording
and intent replay. The registry invokes host recovery callbacks only through
its explicit `recover` operation. Durable filesystem recovery and local
metadata separation still need implementation.

Use the registry with `runActionGroup`, `composeActions` or a replay session.
Each execution context supplies the guarded `db`, current `actions` frame and
`value` containing a `ServiceContext`. Create those limits with
`createServiceContext`. The context type can include additional host fields.
Replay validates against the executing host's limits and resolves layout against
its current rows while retaining the original envelope and recorded bindings.

Handler semantics, invocation shapes and allocation paths belong to contract
version 1. Incompatible service changes require a new registry version. This
factory is an internal opt-in integration and does not install action history,
route application writes or activate guards.

## Request an inventory repair

`system.repair` is a syncable version 1 action with an explicit repair target.
Its current envelope is workspace-wide.

```json
{ "args": {}, "body": { "target": "inventories" } }
```

The handler accepts only that target and refuses extra body or routing fields.
`actions/repair.ts` validates the request and calls the inventory repair service
inside the owning action transaction. It clears legacy half placements, moves
overlapping cards and removes stored cards from glue groups. Placement and glue
changes roll back together if SQL, a child or history persistence fails.

Repair reads current rows during intent replay. It may change different cards or
find nothing to do. Each execution retains the original request and bindings,
including no-op executions. Inventory repair allocates no IDs or clock readings
and preserves card timestamps. It can run as a named composition child or inside
a root replay savepoint.

Exact restoration does not invoke this handler. Keep requested repair separate
from loading recorded row images. CLI repair calls and the CLI's post-import
repair still need production action routing and persistent history.

## Root boundary and failure handling

`packages/core/src/actions/execution.ts` runs a selected registry inside one adapter
write transaction. It checks the root contract against the schema before entering
handlers. The selected version applies to every descendant. Recording and intent
replay use the same registered intent handler with different binding providers.
File recovery remains a separate registry operation. The
[composition API](action-composition.md) uses this scope to record direct child
IDs and enforce callback and reader access.

Before entering a handler, the scope enables and verifies `foreign_keys` and
`recursive_triggers` on its transaction connection. The host must enable foreign
keys before opening the transaction because SQLite cannot change that flag within
one. The scope checks both flags again after the completion hook. A failed check
rolls back application data and completed history. New roots repeat the setup so
connections recycled by the driver retain recursive trigger behavior.

A root owns a failure latch outside SQLite. The first child dispatch, validation,
service or SQL failure is retained even when a handler catches it. SQL savepoint
rollback cannot clear the latch. Later child calls fail with the same cause, and
the adapter transaction rolls back before the group rejects. Each new root gets
a fresh scope.

A handler must finish its outstanding children, service operations and SQL before
it returns. Otherwise the scope fails the root and waits for that work to settle
before rollback. Ignored child and service failures are observed by the scope.
Callbacks are never retried automatically.

## Handler ownership

Each handler receives its own guarded transaction handle and child dispatcher.
Children run sequentially. A suspended parent cannot dispatch another child,
allocate values or execute SQL while its child owns the frame. Queries built
before the child started are checked again when executed. Child entry is also
refused while parent SQL remains outstanding.

The guarded handle supports ordinary query builders, relational reads and
transaction-bound resource services. It hides raw transaction internals and
nested transaction callbacks. Handles retained after their frame closes cannot
execute SQL. Trusted persistence hooks receive the raw transaction for log and
context updates. The completion hook receives all execution records and generated
bindings before commit, so persistence can remain atomic with application data.
A completion-hook failure rolls back the entire group.

`actions/service-frame.ts` connects every core service function ending in `InTx`
to its active execution frame. The bridge catches validation failures before SQL
and tracks the Promise returned to the caller. Ordinary transactions without an
execution frame retain their existing behavior. Mandatory active-action checks
for record APIs and complete service coverage remain separate integration work.

Stacking, squash, layer and partition removal, board scope removal and namespace
administration now expose service and record variants that reuse the caller's
transaction. Their service wrappers share the current failure latch. The ordinary
service entry points open one adapter transaction and call those same variants.

## Invocations and allocations

The original root envelope and each execution's child envelope are copied and
frozen. Handlers receive private input copies for validation and normalization.
Execution records include parent IDs, the contract version, handler-entry ordinals
and the bindings used by that handler. Children with no row changes still get
execution records.

Child IDs use handler-defined stable keys and the full invocation hierarchy.
Each hierarchy level is encoded separately so a multipart key cannot collide
with a deeper tree. Entity IDs and clock paths are scoped to their handler.
Duplicate child paths or allocated action IDs fail the root.

Replay may reorder or skip existing bindings but cannot allocate a new value.
The full original binding map remains available. Replayed child arguments and
entry order belong to the new execution records. Earlier returned records and
the root invocation remain unchanged.

`actions/allocations.ts` connects guarded handles to their handler's binding
provider. Covered record helpers supply IDs and card timestamps explicitly before
SQL execution. Handles outside an action retain their existing defaults. A closed
handle keeps its allocation binding so later calls fail ownership checks before
they can fall back to a new ID or clock reading.

The following allocation keys are scoped by the selected contract, handler and
invocation hierarchy.

| Write | Key passed to the handler's provider |
| --- | --- |
| One namespace, partition, layer, scope, scope area, warp, inventory, glue or card | `["entity", table]` |
| Cards supplied as a batch | `["entity", "card", "batch", inputIndex]` |
| One card's creation time | `["clock", "card", "create"]` |
| A batch's shared creation time | `["clock", "card", "batch"]` |
| A card's text update | `["clock", "card", "update", cardId]` |
| A squash inventory | `["entity", "inventory", "squash", sourceCardId]` |
| A squash piece | `["entity", "card", "squash", sourceCardId, segmentIndex]` |
| A squash's shared creation time | `["clock", "card", "squash", sourceCardId]` |

Keys are encoded as JSON tuples. Batch indexes identify the original supplied
input before chunking and database reads. Use stable child action paths for
multiple independent creates of the same table within one named handler.
Creation reads the clock once for both timestamp columns, and once per batch.
Text updates bind a clock even when the existing text matches, so replay can use
that binding if the current row differs. The SQL comparison still preserves the
old timestamp for unchanged text. Geometry-only updates allocate no clock.
Squash segment indexes identify the text's segment roles for the selected source
card. Replay may skip existing segment bindings but cannot add a segment or
substitute a different source without a matching recorded binding.

Bound card times must be nonzero and fit a JavaScript Date. Zero would invoke
migration 0019's wall-clock fallback. Invalid times and unbound allocations latch
the root failure even when a direct record caller catches the error. Valid
historical timestamps before the Unix epoch remain supported.

Taskspace writes, direct ORM inserts and system import handlers need
further integration. Migration 0019's
fallback also needs replacement before activation. These helpers do not enable
mandatory action guards or install production handlers.

## Replay roots inside one transaction

`actions/replay.ts` provides the internal `withActionReplayTransaction` boundary.
Its callback receives a trusted transaction handle and a `replay` function. Pass
the selected registry, root invocation, recorded binding provider, context factory
and persistence hooks to `replay`. Each call uses a root savepoint and a fresh
execution scope. Recording bindings are refused.

Await roots sequentially. A failed root drains its outstanding work, rolls back
data and history, releases its savepoint and then rejects. The caller can handle
the error and run a later root with a fresh failure latch. A caught child failure
still aborts its entire root, even after a handler rolls back its own SQL savepoint.
Successful roots and orchestration bookkeeping commit together when the callback
finishes. An uncaught error or failed outer commit rolls them all back.

Savepoint creation, release or cleanup failures latch an outer transaction failure.
`ActionReplayCleanupError` retains the root cause and cleanup failure. Catching a
boundary failure cannot permit commit or another root.
Overlapping roots also fail the outer transaction. If the callback returns with
an outstanding root, the boundary waits for it before rolling back. Retained
replay functions refuse calls after the callback ends. Connection settings are
verified again before outer commit.

The callback's transaction handle is trusted orchestration access for installing
shared rows and updating reconciliation state between roots. Handlers receive
guarded handles from their execution scope. Keep orchestration SQL outside active
root calls. Failure classification, rejection receipts and hub or spoke policy
remain separate work. This helper never retries callbacks or records outcomes.

## Verify the scope

The shared regression fixture uses real transaction tables on libsql and SQLite
WASM. It tests caught errors, savepoint rollback, pending work, parent ownership,
relational reads, resource services, changed replay branches and marker cleanup.
Replay tests also cover root isolation, fresh scopes, composition descendants,
cleanup failure, overlapping roots, unfinished work and outer commit failure.
Allocation tests call real record and service writes on both adapters. They cover
stable IDs, creation and edit clocks, changed child order, SQL chunking, changed
replay branches, retained handles and ordinary defaults outside action scopes.
Composite service tests cover enclosing rollback, caught failures, namespace
defaults and squash replay, including late SQL failures and changed segment counts.
The service registry fixture records and replays every database kind on both
adapters. It checks namespace ownership, local-only refusal, host limits,
composition rollback and unchanged original envelopes.
Repair tests cover explicit targets, changed replay results, no-op execution
records, half placements, late failures and savepoint isolation.

```sh
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-execution.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-execution.test.ts
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-replay.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-replay.test.ts
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-allocations.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-allocations.test.ts
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-composite-services.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-composite-services.test.ts
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-service-registry.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-service-registry.test.ts
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-repair.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-repair.test.ts
```

Production integration must supply persistent action/context hooks, route all
registered handlers through the scope, bind generated service values and connect
replay transactions to reconciliation. The browser capture/restoration gate
remains incomplete. Existing application writes do not yet produce action logs.
