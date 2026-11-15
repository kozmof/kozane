# Action composition

The internal composition API records a callback's direct action calls and replays
the recorded list. It is opt-in. Existing `composeWrite` callers retain their
current transaction API until they are migrated. Stamping remains disabled.

## Record a composition

`packages/core/src/actions/composition.ts` provides `composeActions` and a
version 1 registry factory with the built-in `system.compose` handler. Supply
registered resource handlers, a fresh recording binding provider, registered
read helpers and the adapter database.

The callback receives `read` and `dispatch`. `read` calls a registered helper
with copied JSON-compatible input. A helper receives query builders and relational
reads without raw SQL or mutation methods. `dispatch` takes a stable path, a
syncable action kind and its complete invocation envelope. Await dispatches
sequentially. Returned values and reader results can resolve arguments for later
calls in the same transaction.

Direct transaction, raw SQL and record access through the callback facade is
refused. Attempted access latches a root failure even when the callback catches
it. Reader validation errors, child errors and outstanding work use the same
[execution-scope failure latch](action-execution-scopes.md). A later failure rolls
back earlier child writes.

Local-only action kinds are excluded from the typed dispatcher and rejected at
runtime. Their recovery handlers are never invoked by composition. Registered
read helpers remain trusted application code. Shared-table read footprints and
production reader registration must be settled before sync activation.

## Freeze the root invocation

The committed root input contains only direct children in invocation order.
Each child includes its action ID, stable path, kind and original envelope.

```json
{
  "args": {},
  "body": {
    "children": [
      {
        "id": "child-action-id",
        "path": ["edit", "card-id"],
        "kind": "cards.update",
        "input": {
          "args": { "namespaceId": "namespace-id", "cardId": "card-id" },
          "body": { "content": "Edited text" }
        }
      }
    ]
  }
}
```

The initial root entry is provisional while the recording callback runs. The
completion hook receives the finalized root invocation and its root execution
record before the adapter commits. Persist those values together with all child
executions, bindings and effects. A completion-hook or commit failure must publish
no group. The helper returns the finalized result only after successful commit.

Input snapshots are copied before dispatch and frozen at completion. Changing a
caller's input while a child is pending cannot change its recorded invocation.
All children use the root registry's contract version.

## Replay the frozen list

`replayComposition` accepts the matching root invocation and recorded binding map.
It supplies no callback or recording-time reader functions. The registered handler
interprets the list sequentially and checks each bound child ID before entering
that child's handler. New allocations remain forbidden during replay.

Named child handlers own their descendants. Their execution records are retained
for audit, and are not flattened into additional root-list calls. Nested serialized
compositions follow the same rule. A malformed envelope, duplicate ID or path,
local-only child or child-ID mismatch aborts the entire group.

Intent replay assumes that the caller has installed the intended starting state.
It does not undo an origin's existing materialized rows. Authoritative and rebase
history selection, baseline restoration and replay savepoints remain separate
integration work.

## Verify composition

The shared fixture covers recorded read arguments, callback-free replay, named
and nested children, immutable inputs, caught errors and atomic history writes.

```sh
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-composition.test.ts
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-composition.test.ts
```

Production log tables, default resource handlers, caller migration, durable action
attribution and browser capture/restoration verification remain pending.
