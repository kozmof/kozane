# Prototype durable epoch transitions

The capture prototype keeps application writes blocked while a migration is
incomplete. It persists progress and a candidate baseline so restart recovery
can resume without rerunning a committed repair.

These helpers live in `packages/kozane/src/test-utils/action-epochs.ts`.
The tables and guards exist only in test databases. Production epoch tables,
migration hooks and activation remain pending.

[Initial capture staging](prototype-capture-initialization.md) reuses this
protocol with a provisional source epoch and no batches by default. An explicitly
requested inventory repair uses one durable batch before validation. Initial
staging blocks shared writes before baseline validation and completes its pin
transfer with first activation.

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

Before the first host image read or isolated validation, a separate transaction
commits a pending baseline owner in `local_asset_manifest`. Its stable identity
binds the exact transition request and candidate hash. Empty baselines receive
an empty manifest owner too. This uses the existing local ownership format.

The final preparation transaction checks the exact active pin and image bytes
again, retains protection and stores the candidate together. Cleanup and owner
release share the database writer lock. A failed validation or final commit
preserves the earlier pending pin. An explicit retry reuses matching protection.

After writing candidate metadata, preparation verifies the exact descriptor,
complete batch progress, retained baseline owner and empty execution context
before commit. Metadata changes at publication roll back the candidate and
retention updates together. Initial capture also supplies staging checks inside
the candidate read and locked publication boundaries, including after final
image callbacks and the metadata write.

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

Before first activation commits, the helper reads the installed epoch, baseline
and archives with the tagged codec. It requires the exact candidate and completed
batch progress, an empty selection, unchanged earlier archives and retained action,
execution and effect records. It also rechecks live rows, schema, guards, empty
markers, connection flags and the candidate owner's exact retained metadata.
Changed values or storage classes refuse activation.

Initial staging completion runs inside this boundary before final verification.
Any mismatch rolls back activation and the staging-pin release together. The
previous epoch, prepared candidate and retained protection remain available for
an explicit retry without repeating committed repair.

First activation requires the candidate's exact retained owner. Missing, pending,
released or changed protection refuses activation before image reads. Verification
and activation hold the same writer lock, so cleanup cannot remove protection
between them. A failed activation commit leaves the candidate and retained pin
intact for restart recovery.

Archived action, execution and effect rows stay intact. New action runs belong
to the newly active epoch. Restoration cannot select a previous epoch's runs
against the new baseline. A matching activation retry preserves later edits.
Persistent capture guards continue to reject unstamped writes after activation.

The candidate keeps its owner when it becomes the active baseline. Source
baseline and action-history owners remain untouched. New baseline images stay
protected after their last live card disappears. Release requires a separate
explicit retention decision. Matching completed activation retries acknowledge
the earlier commit without recreating released pins or replaying later edits.

Preparation returns `changed`, `sha256` and `owner`.
`captureEpochBaselineOwner(request, sha256)` derives the same immutable owner
after restart. The owner identifies protection and does not authorize activation.

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

`lib/server/action-epoch-image-retention.test.ts` uses real image files and local
manifest ownership. It covers cleanup after live references disappear, pending
pin visibility, readable archived bytes, restart after failed candidate and
activation commits, and competing cleanup or release during publication.

Browser verification remains pending. Production migration authorization,
schema-version policy, integration of epoch asset ownership and workspace
activation remain subject to the existing adapter gate.
