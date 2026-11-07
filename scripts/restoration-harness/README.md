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
The disposable sample and its metadata are regenerated on each build.
Retained corpus databases keep their original bytes and recorded expectations. The CI `browser-e2e` job runs
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
New attempt/generation and staged-worker reset cases are prepared for the next CI run.

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

`WorkerContext` shares verified original worker bytes, the compiled wasm module and sample
bytes across candidate creation. Asset URLs resolve from the emitted module URL and stay
content-free after navigation. Each candidate owns a separate worker and memory database.
Closing a candidate terminates its worker. Reset uses cached assets and makes no HTTP requests.

Call `restorationHarness.openSession(namespaceId)` for a retained reset case. Its isolated root
lifetime shares one operation queue across `read()`, `addCard(content)`, `reset()` and `close()`.
Card creation uses public core services. Reset validates a separate worker candidate, applies
the sample board URL inside the barrier, activates the new generation, attempts saved-copy
deletion and closes the old worker. Later queued reads resolve the new namespace. Failed reset
keeps the live worker and its edits. The optional reset controls inject fixture SQL, view failures
or deletion failures into the harness. Close every retained case explicitly.

Real-wasm Node checks keep separate candidate handles open during reset and verify retained
edits, rejected schema/foreign-key defects, URL/storage preservation and old-handle cleanup.
Prepared browser cases check the same boundaries with separate workers and assert zero HTTP
requests during reset, including worker requests.

A root-owned `ActiveClock` now shares budgets across asset fetching/body consumption/hashing,
wasm compilation, initialization and RPC replies. BFCache residence and supported freeze/resume
events pause accounting. Visibility alone does not. A monotonic one-second heartbeat detects
ambiguous gaps longer than two seconds. Each gap charges one second against retained budgets,
capped at the remaining amount, without replenishing or restarting them.

Results delivered during suspension are reconciled before overdue work, including completed
child stages whose parent is awaiting them. New database dispatch waits during confirmed
suspension and reconciliation. Queue waiting consumes no RPC deadline. Expiry cancels remaining
stage resources and terminates the context's workers. No operation is replayed. Test deadlines
must be positive and finite. The Phase 0 standalone default remains a wall-clock deadline.

`ResumeGate` runs two checks after suspension. A responsiveness probe bypasses wasm loading,
database readiness and both operation queues. Once a handle exists, a read-only `SELECT 1`
check waits for already dispatched database replies to settle. It bypasses the service queue
and never commits or rolls back an existing transaction. Both checks have separate 10-second
active-time deadlines. Tests may inject shorter positive finite health deadlines.

Pending database replies and health checks retain their own budgets across further pauses.
A successful probe cannot extend a lost SQL reply's deadline. Repeated gaps do not redispatch
pending checks. New database work, startup readiness, recovery deletion and reset activation
wait for the current checks. Stale health outcomes cannot open the gate. Failure closes the
context and preserves recovery data.

Every worker message carries a request and worker-instance ID. Replies must match both.
Verified Blob URLs stay alive until worker termination. The packed build also executes the
actual bundled worker under Node to check early probes, instance binding and transaction
preservation through connection checks. Prepared browser cases cover healthy resume with
unsaved edits, a mutation reply held across suspension and a stalled resume probe.

`suspension.spec.ts` holds startup at worker fetch, partial response consumption, hashing,
wasm compilation, initialization delivery, service-view validation and a dispatched validation
reply. It simulates a confirmed 90-second pause with Playwright's clock, preserves the saved
copy, and verifies worker health before releasing the held stage. A separate case covers
supported document freeze/resume events. The freeze case skips only when the browser does
not expose those lifecycle events.

The real navigation case leaves for `/away`, waits longer than its configured RPC and health
deadlines, and returns through browser history. It requires `pageshow.persisted`, the same
in-memory session and retained unsaved edits. Additional cases check that hidden execution
still expires stalled replies and repeated ambiguous gaps exhaust a pre-worker asset budget.
These tests are discovered by the existing CI command alongside the restoration cases.

The build verifies all retained corpus hashes before copying database assets into the harness.
The server exposes only the catalog and explicitly listed database paths. `corpus.spec.ts`
restores every recorded selection through the verified worker. Each case checks the fetched
bytes, requires the restored source, preserves the exact saved envelope and compares a stable
view summary with the original expectation. The first cohort adds eleven cases covering empty,
sole, multiple and default namespace states, missing selections and populated Unicode data.
Discovery finds 44 browser cases across three suites.

P3-10 remains in progress. The expanded suspension and corpus cases await CI execution.
Basic `run()` cases close their candidate after reporting validation. Retained cases
keep it until `close()`. The persistent editing backend is implemented in Phase 4.
See the [task list](../../docs/backend-separation/Kozane-Client-Backend-Separation-and-Web-Demo-Tasks.md).
