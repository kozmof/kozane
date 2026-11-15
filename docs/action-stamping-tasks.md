# Action stamping and sync tasks

Implement durable action stamping and restoration first, then add sync. This is
the canonical progress list. Implemented contracts and checks are documented in
the [write inventory](action-stamping-write-inventory.md),
[capture prototype](action-capture-prototype.md),
[execution scopes](action-execution-scopes.md) and
[composition API](action-composition.md).

Phases 1–3 are in progress. See the [write inventory](action-stamping-write-inventory.md).
Version 1 client envelopes and sync classifications have compile-time coverage.
Versioned registry selection, complete routing checks, replay-safe allocation
bindings, import timestamp resolution and the tagged row codec are implemented
and unit-tested. Production handler installation, system envelopes, persistence
and write-path integration remain pending. The persistent capture, unconstrained
projection and lossless installation prototype passes on libsql and Node WASM.
Browser verification remains pending because Chromium was unavailable and the
environment denied its download. Skipped-insert upserts have been removed. Direct
layer, partition and scope service writes now use adapter transactions and expose
transaction-bound variants. An opt-in execution scope now provides handler-entry
ordering, scoped bindings, ownership checks and a failure latch shared by core
transaction-bound services. Caught child, SQL and pre-SQL service failures abort
the root after outstanding work settles. Production action attribution and
default-handler integration remain pending. The opt-in
`system.compose` implementation now records direct child envelopes and IDs,
provides registered readers and sequential dispatch, and replays without the
recording callback. Existing `composeWrite` callers still need migration. Capture
guards remain disabled.

Connection setup now enables and verifies foreign keys and recursive triggers in
the Node host, WASM parity adapter and restoration worker. Opt-in action scopes
repeat setup before handlers and verify again after completion. Libsql and Node
WASM tests cover recycled connections, entry refusal and rollback when settings
change. Browser runtime verification remains pending.

Opt-in replay transactions now isolate each root with a savepoint and a fresh
execution scope. Compositions can use the same session. Failed roots roll back
before later roots enter. Savepoint boundary failures, overlapping calls and
unfinished roots abort the outer transaction even when caught. Production
reconciliation, outcome handling and failure classification remain pending.

## Version one

Complete phases 1–5 before shipping stamping and restoration. Keep guards opt-in
until write coverage and exact restoration checks pass. Treat the adapter
prototype in phase 2 as a gate before finalizing the log format.

### 1. Inventory writes and define action contracts

- [x] Inventory service, record, CLI and system write paths, including direct statements, import, repair and migrations.
- [x] Inventory generated IDs, ORM defaults, SQL clock expressions, business triggers and conflict modes.
- [x] Define the versioned core action registry and type-check coverage against client write classifications.
- [ ] Define complete invocation envelopes, including routing and target IDs, for every registered kind.
- [ ] Classify each kind as `syncable` or `local-only` and define its replay or file recovery handler.
- [ ] Define stable binding paths for entity IDs, child action IDs and clock readings. Preserve bindings when query ordering changes.
- [ ] Persist `contract_ver` from the first execution and dispatch the whole group through its compatible registry.
- [ ] Refuse unbound replay allocations without changing the binding map. Preserve original invocations when replay resolves child arguments differently.
- [ ] Replace migration 0019's timestamp fallback with explicit bindings and record-mode validation. Preserve historical timestamps during restoration.
- [ ] Verify complete envelopes, changed replay branches, import timestamp normalization and contract compatibility.

### 2. Prove capture and restoration on every adapter

- [ ] Prototype persistent `BEFORE` capture with an unconstrained row projection on every supported adapter.
- [x] Implement the tagged row-value codec for baseline rows, primary keys and full effect images.
- [ ] Verify signed 64-bit integers without JavaScript number conversion, storage classes, finite REAL bits, NULL, Unicode text, embedded NUL characters and blobs.
- [ ] Refuse malformed encodings and unsupported baseline or stamped values without changing application data.
- [ ] Verify capture order for nested triggers, repeated updates, FK cascades and intermediate row images under different trigger creation orders.
- [ ] Verify projection reconstruction and lossless installation together. Refuse activation on an adapter that cannot satisfy the codec contract.
- [ ] Add action, effect-set, execution and persistent context tables after the prototype passes.
- [ ] Implement root and child attribution with separate group-wide execution and effect counters. Include children with no row effects.
- [ ] Keep origin effect sets immutable and retain execution records for each later execution.
- [x] Add shared connection configuration and verification, and check both flags before handlers and after completion in opt-in action scopes.
- [ ] Verify `foreign_keys` and `recursive_triggers` on every supported adapter at runtime. Libsql and Node WASM pass. Browser execution remains pending.
- [ ] Restrict mutating business triggers to `AFTER` execution. Refuse primary-key changes and unsupported skipped-write behavior.
- [ ] Verify unstamped raw writes fail and marker cleanup survives success, rollback and failed commit.

### 3. Route writes through stamped boundaries

- [ ] Wrap every service write in a stamped adapter transaction, including direct layer creation and rename.
- [ ] Require active action groups in transaction-bound record and service methods.
- [ ] Add stamped import and requested repair operations.
- [x] Replace no-op upserts with existence checks inside serialized write transactions.
- [x] Implement `system.compose` with read helpers, a registered dispatcher and a serialized ordered list of direct children. The implementation is opt-in; caller migration remains pending.
- [ ] Migrate composition callers that use direct SQL or need replayed control flow to dispatcher calls or named handlers.
- [x] Enforce handler ownership, sequential child calls and refusal of parent SQL while a child is active in opted-in execution scopes.
- [x] Add a root failure latch that survives caught child errors and SQL savepoints, and check it before transaction commit.
- [x] Integrate fresh execution scopes with root replay savepoints and check the latch before savepoint release in opt-in replay transactions.
- [x] Wait for outstanding children and service work to settle before rollback and discard each failed root's execution scope.
- [ ] Separate filesystem handlers from syncable database handlers. Refuse local-only children in generic compositions and named syncable handlers.
- [ ] Move taskspace paths and observations into local metadata storage before baseline capture. Preserve metadata for absent taskspaces without cascading deletion.
- [ ] Keep shared taskspace rename independent of directory movement and local observation timestamps.
- [ ] Verify write coverage, caught failures, overlapping calls, outstanding children, nested execution order and serialized composition replay.
- [ ] Verify all five taskspace file methods remain local-only and cannot mutate shared application rows.
- [ ] Verify shared restoration preserves local taskspace metadata and installs no remote directory attachments.

### 4. Implement baselines, restoration and migration recovery

- [ ] Add workspace and epoch identities, schema and encoding versions, baseline hashes and restoration selections.
- [ ] Implement restartable initial baseline capture for populated and seeded databases with application writes blocked until activation.
- [ ] Reconstruct the target projection from the baseline and selected complete effect sets in materialization order. Check every full before image.
- [ ] Validate target rows in an isolated database with the epoch's constraints, foreign keys and trigger-enforced invariants.
- [ ] Read back loaded validation rows with the tagged codec and compare them with the target projection, including storage classes and exact REAL bits. Refuse installation or activation on any mismatch.
- [ ] Define the epoch's acyclic foreign-key load order and refuse unsupported schemas before changing live rows.
- [ ] Implement trusted restore mode with active guards and suppressed capture, mutating business triggers and timestamp normalization.
- [ ] Stage standalone restoration and atomically activate it only after validation and installation of its required history and bookkeeping.
- [ ] Implement replacement of shared rows inside one reconciliation transaction while preserving local metadata and log tables.
- [ ] Rebuild derived data after installation. Keep requested repair separate from exact restoration.
- [ ] Capture full local recovery snapshots and shared checkpoint selections from one consistent database read transaction.
- [ ] Retain required history and assets while assembling recovery bundles. Publish only complete bundles.
- [ ] Validate device, workspace, epoch and checkpoint identities before loading a local snapshot once. Refuse complete recovery with a missing or mismatched snapshot.
- [ ] Support explicit shared-only recovery and inspect pending file operations without automatically repeating filesystem changes.
- [ ] Add durable epoch transitions that block application writes across connections and restarts.
- [ ] Implement trusted migrate mode and atomic migration batches covering schema, data, migration history, progress and mode cleanup.
- [ ] Resume incomplete transitions without rerunning committed repair. Validate guards and rows before atomically activating the new baseline.
- [ ] Verify baseline replay against the compatibility corpus, populated workspace upgrades, restoration constraints, corrupt images and interrupted activation.
- [ ] Verify validation rejects loaded rows whose storage classes or REAL bits differ from the target projection, even when constraints pass. Preserve the existing destination on failure.
- [ ] Verify consistent local recovery snapshots and migration interruption before and after each durable boundary.

### 5. Record filesystem operations and protect assets

- [ ] Add pending and confirmed local file-operation records with affected paths and intended content hashes where applicable.
- [ ] Reconcile interrupted taskspace file operations against disk state on startup without automatically retrying external-effect callbacks.
- [ ] Add asset manifests to baselines and effect sets, covering references in invocations and full before and after images.
- [ ] Reserve image names with durable staging pins before files become visible, then write and verify their bytes.
- [ ] Commit image references, manifests and staging completion together. Preserve staging pins after rollback.
- [ ] Serialize file installation, staging transitions and cleanup decisions so protection transfers without a gap.
- [ ] Protect assets needed by live rows, uploads, staged transfers, pending work, retained history and recovery records.
- [ ] Recover or explicitly abandon interrupted uploads before releasing staging pins.
- [ ] Verify cleanup races and crashes before file creation, after installation and after action commit.
- [ ] Enable mandatory guards and ship version one only after phases 1–5 and their verification pass.

## Later sync work

Settle phase 6 before implementing the sync protocol. Keep transport, conflict UI
and character-level text merging outside version one.

### 6. Resolve sync policy questions

- [ ] Choose the first sync setting from own devices, shared team workspaces or browser and offline use.
- [ ] Define semantic conflict rules for inventory placement, stacking and layer order, scope names and default namespaces.
- [ ] Define concurrent text edit ordering and durable preservation of losing text.
- [ ] Define retention and compaction policies for baselines, history and outcome receipts.
- [ ] Define recovery of offline pending work across schema epoch changes.
- [ ] Define deletion and text purge behavior across baselines, effects, inputs, recovery records and remote copies.
- [ ] Set retry limits and backoff for temporary failures and contention.

### 7. Add sync setup and durable state

- [ ] Implement resumable hub initialization from a populated workspace using a new baseline, verified asset manifest and idempotent setup identity.
- [ ] Archive existing origin history and start empty submission and materialization lists only after matching hub initialization succeeds.
- [ ] Stage joining an existing hub in a separate destination and activate only after verified installation.
- [ ] Preserve pending work on baseline-required responses and stop unsupported epoch recovery without replacing the workspace.
- [ ] Add durable confirmed cursors, queues, accepted-group mappings, receipts and ordered materialization selections.
- [ ] Track hub outcomes independently from local materialization, including blocked pending roots.
- [ ] Freeze each submitted root's contract version, envelope, bindings and dependencies with its canonical payload hash.
- [ ] Register and enforce conservative shared-table read and mutation footprints, including descendants, triggers and composition callback reads.
- [ ] Derive dependencies on earlier pending roots and require prerequisites to be materialized before local execution.
- [ ] Revalidate dependencies before submission and refuse changes to frozen dependency lists afterward.
- [ ] Persist entire prerequisite closures in unresolved state atomically before sending requests. Recover committed obligations even if no request was sent before a crash.
- [ ] Verify setup interruption, identity mismatches, dependency discovery, submission races and out-of-order prerequisite delivery.

### 8. Implement hub acceptance and asset transfer

- [ ] Upload and verify missing image bytes before replay. Keep missing assets retryable and refuse name and hash collisions.
- [ ] Check durable outcomes before contract compatibility or replay and return original receipts for identical retries.
- [ ] Check contract compatibility and frozen dependencies before domain execution. Keep unknown prerequisites retryable.
- [ ] Replay each root through its versioned registry inside a root savepoint without filesystem effects.
- [ ] Atomically commit authoritative executions, effects, manifests, `hub_seq` and acceptance receipts.
- [ ] Roll back permanently failed roots completely and persist only rejection receipts. Leave infrastructure failures retryable without permanent outcomes.
- [ ] Retain deduplication state for retried IDs and require bootstrap when compaction removes that state.
- [ ] Stage and verify downloads before bootstrap activation or reconciliation. Pin staged assets and keep network transfers outside database transactions.
- [ ] Verify idempotency, concurrent duplicates, payload mismatch refusal, failure isolation, unsupported contracts and interrupted or corrupt downloads.

### 9. Implement spoke reconciliation and expose sync

- [ ] Serialize cycles that pull through a fixed head, push prepared roots and pull again. Page only on complete root boundaries.
- [ ] Preflight replay contract compatibility and reconstruct confirmed state before replaying pending roots.
- [ ] Match authoritative root IDs against submitted work before pending replay, including blocked roots and lost-response cases.
- [ ] Apply rejection receipts through reconciliation even when no new groups arrive. Preserve origin effects, reasons and rejected text for recovery.
- [ ] Reject unsubmitted dependents locally and keep submitted dependents blocked until their hub outcomes resolve.
- [ ] Replay eligible pending roots in dependency order with separate savepoints and fresh execution scopes.
- [ ] Roll back failed replays completely. Move permanently failed unsubmitted roots to local recovery. Keep unresolved or accepted roots pending and blocked, and keep temporary failures pending. Preserve invocations, origin effects and failure reasons, and continue outcome recovery for unresolved roots.
- [ ] Create new rebase sets without overwriting origin history and omit blocked roots from the replacement materialization list.
- [ ] Commit shared rows, replay sets, queues, receipts, selections and `confirmed_seq` atomically. Keep receipt-only cursors unchanged.
- [ ] Verify own-action echoes, hub rejection application, uncertain submission, restoration after rebase and reconciliation crash recovery.
- [ ] Verify permanent local replay failures move unsubmitted roots to recovery while unresolved or accepted roots remain pending and blocked. Verify temporary failures stay pending and later authoritative acceptance materializes blocked roots exactly once.
- [ ] Simulate random offline edits and sync ordering across multiple spokes. Require convergence and recoverable rejected work.
- [ ] Expose the sync endpoint and `kozane sync <remote>` only after restoration and convergence checks pass.
