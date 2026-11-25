# Prototype restartable initial capture

The initialization prototype stages a first shared baseline with writes blocked
until validation and activation finish. It preserves pending image protection and
initialization state across restarts.

These helpers live in `packages/kozane/src/test-utils/action-initialization.ts`.
They use test-only capture tables and guards. Production enrollment and
application routing remain pending.

## Stage a canonical source

Start with an empty, seeded or populated database that already has the bundled
schema and complete migration history. Finish schema migrations and repairs other
than inventory repair before this prototype boundary.

Choose an initialization ID and a first active epoch ID. The schema ID must be
the current bundled migration. The epoch ID must differ from the fixture's
provisional `initial` epoch.

Include `repair: "inventories"` to request inventory repair before validation.
Omit that property when no repair is needed. The chosen plan becomes immutable
at the staging commit.

```ts
const initialization = { id, epochId, schemaId, repair: "inventories" as const };
const staged = await stageCaptureInitialization(db, initialization, catalog);
```

`stageCaptureInitialization` owns the identities and catalog before asynchronous
work. One transaction captures provisional shared rows and image requirements,
installs capture guards and an empty execution context, reserves an initial
pending-work image owner and records the epoch transition. The transition has
one inventory repair batch when requested, or no batches otherwise. The repair
plan participates in the pin identity. Requests without repair retain the
existing pin identity and zero-batch behavior.

That commit blocks ordinary shared inserts, updates and deletes. No-op action
entry and restoration are blocked too. Another connection cannot write through
the staging commit, and the persistent guards remain effective after restart.
Local taskspace metadata and operation records remain intact.

Staging does not read physical image bytes or authorize action execution. A failed
staging commit rolls back its schema, guards, transition and image owner together.
Matching retries reuse the persisted state without recapturing provisional rows.
Conflicting identities, unrelated capture fixtures, unsupported schemas and
temporary schema objects are refused.

## Run requested inventory repair

For a staged request with `repair: "inventories"`, run repair before preparing the
initial baseline.

```ts
await repairCaptureInitialization(db, initialization);
```

The helper runs the same inventory repair implementation used by `system.repair`
as the pinned `initial-inventory-repair:v1` migration batch. It clears half
placements, resolves overlaps and removes stored cards from glue groups. It preserves exact card
timestamps, local taskspace metadata and the provisional baseline. It publishes
no action executions or effects. The first active baseline includes the repaired
rows.

The repair transaction owns the migration marker and writer lock. It checks the
initial staging pin, guards, foreign keys, connection flags and archived history.
Data changes, batch history, progress and marker cleanup commit together. A failed
statement, failed commit or remaining foreign-key violation rolls them all back.
Shared writes stay blocked, and pending image protection remains intact.

Matching retries return `changed: false` without invoking repair after its batch
commits. This also holds after candidate preparation and completed activation.
Later action changes remain intact. Restart recovery uses the same request and
checks durable progress instead of repeating committed repair.

Changing or adding a repair plan after staging is refused. Repair is never
automatic, and calling this helper without a requested inventory repair is an
error. Exact restoration does not invoke repair. Other validation failures remain
blocked for separate recovery.

## Validate the initial baseline

Prepare the candidate with a separate empty validation database factory and a
trusted image reader. Preparation refuses incomplete repair batches before
allocating a validation database or reserving a candidate pin.

```ts
const prepared = await prepareCaptureInitialization(
  db, initialization, createValidationDatabase, catalog, readAsset,
);
```

The helper reuses [epoch baseline preparation](prototype-epoch-transitions.md).
It commits a stable candidate baseline pin before image reads or isolated SQL
validation. Exact rows, image bytes, schema, guards and connection settings must
pass before the retained candidate commits.

Preparation rechecks the initial staging record and pin in the candidate read
and in the transactions that reserve protection and publish the candidate.
Publication checks repeat after final image callbacks and after the candidate
metadata write. The candidate descriptor, completed batch progress, retained
baseline owner and empty execution context must still match before commit.

Releasing the initial pin during validation refuses publication. The reviewed
release stays committed, and any earlier candidate pin remains available for
inspection. Changes made inside the final publication transaction roll back
with its candidate and retention updates. Preparation does not recreate released
protection, remove image evidence or activate writes.

Failed validation leaves shared writes blocked. A failed candidate commit
preserves both the original staging pin and the earlier committed candidate pin.
Restart recovery can retry validation without reinstalling guards or repeating
migration or repair. The host owns disposal of every validation database.

## Activate and complete staging together

Activate only after a candidate is prepared.

```ts
await activateCaptureInitialization(db, initialization, readAsset);
```

First activation requires active initial staging protection and the exact
retained candidate owner. It verifies the candidate and image bytes, selects the
first active epoch and baseline, completes the transition and releases the initial
staging owner in one transaction. The retained baseline owner continues protecting
the images. Cleanup and owner release share the writer lock throughout.

A failure to release the staging pin rolls activation back. A failed final commit
leaves the initial transition blocked, the candidate retained and the staging pin
active. Reopen the database and retry the same initialization.

Matching completed retries acknowledge the earlier commit without overwriting
later actions or re-enabling reviewed, released protection. Conflicting or
inconsistent completion records refuse success. Source history is not replayed
and pending filesystem callbacks are not repeated.

The staging result includes `changed`, `request` and `owner`.
`captureInitializationOwner(initialization)` derives the same initial pin after
restart. Preparation returns the candidate's separate `owner` and `sha256`.

## Verify the boundaries

`db/api/action-initialization.test.ts` covers empty and populated sources, blocked
writes, invalid rows, exact identities, temporary schema refusal, image
verification and failure at each commit. Repair tests cover overlaps, glue groups,
legacy half placements, exact timestamps including unsafe integers, explicit plan
selection, incomplete batches, failed repair and commit rollback, and retained
staging protection. Publication tests cover pin release before reservation and
during validation, changed protection during final callbacks, and candidate and
owner changes during metadata publication. It runs in the
[fixed capture gate](action-capture-prototype.md#run-the-checks) on native and
Node WASM adapters.

`lib/server/action-initialization.test.ts` uses real files and multiple native
connections. It exercises restarts before preparation, after failed validation,
after candidate preparation and after failed activation. Competing writes,
cleanup and owner release cannot cross a held staging or activation transaction.
Repair tests reopen before and after its commit, recover a failed repair commit
and refuse competing writes, cleanup and pin release during a held repair batch.
Preparation tests refuse pin release from another connection during validation
and serialize final publication with application writes, cleanup and pin release.

Browser runtime verification and production initialization integration remain
pending. The existing fixture installer remains an immediate setup helper for
other tests. The staged initialization functions establish the restartable
protocol for these tests without changing production migrations or payloads.
