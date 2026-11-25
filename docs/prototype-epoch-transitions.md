# Prototype durable epoch transitions

The capture prototype keeps application writes blocked while a migration is
incomplete. It persists progress and a candidate baseline so restart recovery
can resume without rerunning a committed repair.

These helpers live in `packages/kozane/src/test-utils/action-epochs.ts`.
The tables and guards exist only in test databases. Production epoch tables,
migration hooks and activation remain pending.

## Establish a transition

`beginCaptureEpochTransition` takes an independently established transition ID,
source and target epoch and schema labels, and an ordered batch ID inventory.
It requires an empty record marker, no incomplete action run and the matching
active source epoch. Conflicting requests, reused epoch identities and a second
active transition are refused.

The committed transition blocks persistent shared-table guards in both record
and restore mode. Action entry also checks it, so a no-op handler cannot bypass
the block. Another connection and a reopened database observe the same state.
The local taskspace metadata tables remain outside shared capture.

## Commit each migration batch once

`runCaptureMigrationBatch` acquires the database writer lock and checks the exact
request, active epoch, guard definitions, prior batch history and empty markers.
It permits only the next batch. A committed batch returns `changed: false` on
retry without invoking its callback.

The hook records the active transition and batch marker before entering migrate
mode. Shared guards require both markers, the empty action context and matching
durable progress. Setting migrate mode alone does not authorize writes.

The callback owns its data and schema changes. Business triggers remain active
during migration unless the callback changes them explicitly. Effect capture is
suppressed. Rebuilt shared tables must regain their exact capture guards before
the batch completes.

Data, schema, prototype migration history, progress and marker cleanup commit
together. A callback, guard, connection-setting or commit failure rolls the whole
batch back. Existing baselines, selections, actions, executions and effects must
remain byte-for-byte unchanged throughout migration.

## Prepare the candidate before activation

`prepareCaptureEpochBaseline` requires every batch to be complete. It captures
exact shared rows, image requirements, target labels, encoding version and a
schema fingerprint in one read snapshot. Image bytes and isolated SQL validation
must pass before a SHA-256-bound candidate is persisted.

The helper rechecks source history, rows, schema and guards after isolated
validation. Changed evidence refuses the candidate. Failed validation or baseline
publication leaves writes blocked and committed batch progress intact. A matching
retry acknowledges the same candidate without replacing it.

The host supplies separate empty validation databases and owns their disposal.
This prototype validates the bundled shared-table layout. Its schema labels do
not authorize arbitrary historical schemas.

## Activate atomically

`activateCaptureEpoch` checks the candidate hash, rows, schema, guards, connection
settings and image bytes again. It archives the source baseline and selection,
selects the new epoch and baseline, clears the active selection and completes the
transition in one commit. A failed commit preserves the source epoch and the
prepared candidate.

Archived action, execution and effect rows stay intact. New action runs belong
to the newly active epoch. Restoration cannot select a previous epoch's runs
against the new baseline. A matching activation retry preserves later edits.
Persistent capture guards continue to reject unstamped writes after activation.

## Verify the boundaries

The shared adapter tests are in `db/api/action-epochs.test.ts`. Run them with the
native source configuration or the Node WASM parity configuration described in
the [capture prototype guide](action-capture-prototype.md#run-the-checks).
They cover batch ordering, guard loss during rebuild, forged migration markers,
history and candidate corruption, image verification and failure at each commit.

`lib/server/action-epoch-restart.test.ts` exercises real file databases. It closes
and reopens them before repair, after repair, after failed baseline capture,
after candidate preparation and after activation. A competing connection cannot
run duplicate repair while the first batch holds the writer lock.

Browser verification remains pending. Production migration authorization,
schema-version policy, durable asset ownership for new epochs and workspace
activation remain subject to the existing adapter gate.
