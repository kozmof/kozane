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
The fixture and its metadata are regenerated on each build.

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
cleanup, storage errors and deferred deletion. Browser cases currently cover fresh startup,
restoration to a missing namespace, malformed-copy fallback and sample hash mismatch.

P3-10 remains in progress. Browser fault injection, navigation supersession, reset barriers,
suspension-aware deadlines and compatibility-corpus integration remain. The current loader
uses the Phase 0 wall-clock deadlines. The harness reports validation results and closes the
candidate after each case. The persistent editing backend is implemented in Phase 4.
See the [task list](../../docs/backend-separation/Kozane-Client-Backend-Separation-and-Web-Demo-Tasks.md).
