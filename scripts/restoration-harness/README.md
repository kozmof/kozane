# Packed restoration harness

Build and check restoration against an isolated `@kozane/core` tarball before publication.
The harness uses the Phase 0 verified worker loader and the pinned sqlite-wasm engine.
It imports core through public exports and generates a disposable database through public
migration and domain services.

Run `pnpm build:restoration-harness` from the repository root. This runs packed-core checks,
checks harness types in the isolated consumer, validates real wasm database bytes under Node,
and builds `tmp/restoration-harness`. The build verifies that the worker has no runtime
imports. It does not launch a browser.

Run `pnpm test:restoration-harness` to rebuild and execute the browser tests in Playwright
Chromium. The local server uses the demo CSP and serves worker, wasm and database assets.
The browser entry uses the embedded hashes and build-ID handshake before database access.
The fixture and its metadata are regenerated on each build. The CI `browser-e2e` job runs
this command on Node 24 with Chromium for pushes and pull requests.

The shared startup policy reads recovery storage before opening a database. It bounds JSON
and decoded database sizes, validates required own fields and canonical padded base64,
and compares the migration ID. Future valid timestamps are accepted. Extra envelope fields
are ignored. Storage access failures allow memory startup.

Each candidate must pass integrity, foreign-key, complete history and canonical schema checks.
Namespace metadata and the selected initial snapshot come from public services. Empty,
selection-required and explicitly missing destinations are valid restored states. Every sample
candidate must also contain its required sample namespace and a readable snapshot.

Startup validates and closes a sample preflight before opening recovery bytes. A confirmed
invalid copy is closed before sample fallback. Deletion waits until fallback database and
initial-view validation succeed. Unknown or transient failures preserve the copy and return
retry. Asset verification failures and confirmed sample defects require reload. Cleanup failures
cannot authorize corruption fallback. Failed deletion reports that an older copy may restore.

The Node checks exercise this policy with actual exported wasm databases, including incomplete
history, missing indexes and triggers, corrupt bytes, and dangling references outside the
initial namespace. Unit tests cover decoder limits, padding bits, uncertain failures,
cleanup, storage errors and deferred deletion. Browser cases cover fresh startup, restoration to a missing namespace, malformed-copy fallback,
worker and asset failures, executed operations with lost replies, unclassified service failures
and stale navigation. The user reported the CI browser job passing after this suite was added.
New attempt/generation race cases are prepared for the next CI run.

`DestinationTracker` captures a monotonic destination sequence and discards superseded view
results and errors. The startup policy checks the destination again before readiness and saved-copy
deletion. Call the browser harness's `start(namespaceId, beforeView)` to obtain `navigate(id)`
and a result promise. The optional view hook and RPC deadline control support fault injection.
Database-wide failures retain their classification when the destination changes.

`AttemptOwner` issues leases containing startup attempt and candidate-generation stamps.
Beginning another attempt or replacing the generation invalidates old leases and terminates
their workers. Guards run before database work, readiness and saved-copy deletion. Late opened
candidates are closed, and obsolete outcomes return `status: "superseded"`. Ready reports
include their attempt and generation. Check `restorationHarness.isCurrent(report)` before
applying a report after another asynchronous step. Generation replacement belongs to the root
when it replaces a candidate. Failed reset validation must preserve the existing generation.

`ResetSession` accepts a whole-operation serializer shared with reads, edits and export.
Its opener must stage an independent candidate while preserving the live handle. The session
validates the sample namespace and initial view and computes the destination before activating
the next generation. Failed validation preserves the prior state, URL and saved copy. Successful
activation precedes deletion and old-handle cleanup. Deletion and cleanup failures have separate
result flags. Confirmed sample defects block further reset attempts until reload.

P3-10 remains in progress. The new browser races await CI execution. Staged worker reset
integration, suspension-aware deadlines and compatibility-corpus integration remain. The current loader uses the Phase 0 wall-clock deadlines. The harness reports validation results and closes the
candidate after each case. The persistent editing backend is implemented in Phase 4.
See the [task list](../../docs/backend-separation/Kozane-Client-Backend-Separation-and-Web-Demo-Tasks.md).
