# Action execution scopes

The internal execution scope provides one rollback boundary for a root and its
children. It is opt-in and does not activate stamping on application databases.
Production log tables, default handlers and guard activation remain pending.

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

```sh
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-execution.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-execution.test.ts
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-replay.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-replay.test.ts
```

Production integration must supply persistent action/context hooks, route all
registered handlers through the scope, bind generated service values and connect
replay transactions to reconciliation. The browser capture/restoration gate
remains incomplete. Existing application writes do not yet produce action logs.
