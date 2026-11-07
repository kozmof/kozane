# Web demo tasks

Implement the demo in the separate `kozane-demo` repository using published core and client packages. Use the [web demo specification](web-demo-specification.md) for the full contracts and acceptance cases.

Before starting, publish and verify the intended package versions through the [local release flow](releases.md). The current candidates are core 0.1.0, client 0.1.0 and kozane 0.22.0. No initial publication is claimed here.

The shared restoration harness and compatibility corpus remain reusable test infrastructure in this repository. The pre-extraction performance baseline is commit `226facea14e7a9323e4fd6fd1c8d5f4daed76d06`. Keep P4 and acceptance task identifiers stable when transferring this document to the demo repository.

## Phase 4 — Demo implementation

### Repository, sample and navigation

- [ ] P4-01 Create `kozane-demo` with exact published core/client versions and a frozen lockfile. Reuse the verified loader and shared restoration harness.
- [ ] P4-02 Author release sample content in the demo repository and build it through public migrations and services only.
- [ ] P4-03 Finalize the sample as a standalone rollback-journal database. Checkpoint/truncate WAL, verify no busy or pending frames, switch to DELETE mode and close all connections before hashing.
- [ ] P4-04 Validate the finalized bytes through the production browser loader, including full database checks and the required sample namespace/snapshot. Generate the preview from that same artifact.
- [ ] P4-05 Create one browser-root backend, worker and operation queue retained across internal navigation and BFCache. Never share mutable state between prerender requests.
- [ ] P4-06 Prerender `/`, `/board/`, `/namespaces/`, `/tags/` and `/map/` with directory-style URLs. Preserve query/fragment values through root and slashless redirects.
- [ ] P4-07 Implement query-based opaque namespace selection, empty/sole/default/ambiguous-default states and explicit missing destinations. Use fragments for content-bearing filters.
- [ ] P4-08 Add the sandbox banner, install link, recovery indicator, retry/reload controls and capability-based feature visibility.

### Local backend and lifecycle

- [ ] P4-09 Implement `LocalBackend` with shared services and whole-operation serialization for reads, writes, exports and resets. Do not reacquire the outer queue from SQL callbacks or transaction helpers.
- [ ] P4-10 Export and implement `DemoBackend`, immutable recovery status, immediate subscriptions and synchronous idempotent disposal.
- [ ] P4-11 Implement worker/request IDs, internal error envelopes and classification validation. Start 30-second active-time RPC deadlines at dispatch, never during queue waiting.
- [ ] P4-12 Implement worker/rollback failure invalidation, rejection of pending and dependent operations, safe diagnostics and suppression of late publications/saves. Never replay unknown-outcome mutations.
- [ ] P4-13 Implement explicit retry with new attempts and generations, preserving the saved copy and restoration/start-over intent according to the recovery decision contract.
- [ ] P4-14 Implement synchronous reset barriers with reserved enqueue generations and separate active generations. Validate the sample destination inside each barrier before activation or deletion.
- [ ] P4-15 Implement consecutive resets, ordered promise settlement, dependent-operation release and suppression of intermediate readiness/navigation/saves. Handle failed barriers under the specified retry/reload rules.
- [ ] P4-16 Coordinate reset during startup independently of the operation queue. Retain prerequisite loading, close superseded candidates and prevent readiness or queue dependency deadlocks.
- [ ] P4-17 Scope editor stores, undo/redo, dirty buffers, callbacks, selection, drag state and preferences to the generation. Cancel stale callbacks and use an in-memory demo preference adapter that ignores legacy storage keys.

### Startup, assets and suspension

- [ ] P4-18 Embed a manifest with build ID, schema version, fingerprinted absolute asset URLs and hashes. Verify preview/worker IDs and reuse only verified original sample bytes for reset.
- [ ] P4-19 Start worker/wasm loading after FCP. Validate the sample on every startup before accepting restored or fresh working data; cache sample bytes for the root lifetime.
- [ ] P4-20 Add the synchronous CSP-hashed recovery/namespace preview script. Prevent sample flashes during restoration or explicit non-sample destinations and keep controls disabled through hydration and initial live-data application.
- [ ] P4-21 Track navigation sequences during initialization. Reuse database-wide work while superseding destination reads; stale destinations cannot publish readiness, authorize fallback or delete storage.
- [ ] P4-22 Enforce the specified finite asset, compilation, loader and handshake deadlines. Abort fetch/readers, terminate workers, revoke Blob URLs and ignore uncancelable late results after failure/disposal.
- [ ] P4-23 Implement shared active-time accounting for confirmed suspension and ambiguous heartbeat gaps, including pre-worker initialization. Preserve retained budgets without replenishment.
- [ ] P4-24 Implement independent responsiveness probes and read-only resume connection checks with separate 10-second deadlines. Reconcile pending replies before timeout decisions and gate new database work without replay.

### Reload recovery

- [ ] P4-25 Implement guarded `kozane-demo:session` envelope serialization/validation, canonical padded base64 and informational timestamp rules. Exclude preferences and ignore additional envelope fields.
- [ ] P4-26 Implement integrity, foreign-key, complete migration-history, canonical-schema and initial-view validation for restored/sample/reset candidates through public exports.
- [ ] P4-27 Apply the recovery decision table by failure classification and candidate source. Preserve saved bytes for unknown/transient failures; delete invalid/incompatible copies only after validated fallback succeeds.
- [ ] P4-28 Implement generation-local committed revisions and export stamps. Debounce saves by 500 ms with a 5-second maximum scheduling wait and at most one queued/in-flight export.
- [ ] P4-29 Cover only the exported revision after successful storage. Track newer commits and schedule follow-up from their earliest uncovered commit; coalesce visibility/pagehide requests.
- [ ] P4-30 Enforce the 2 MiB database and 3 Mi-character envelope limits before the specified export, transfer, encoding, parsing and decoding stages. Suspend saves for the generation after a size-limit failure.
- [ ] P4-31 Handle storage failures in memory, suppress retries until a later write and attempt stale-copy deletion. Disclose unavailable recovery and failed deletion accurately.
- [ ] P4-32 After validated reset, replace navigation with the sample board and clear filters/selections. Preserve URL and saved data on reset failure and avoid intermediate navigation during consecutive resets.

### Privacy and deployment

- [ ] P4-33 Keep editing, snapshots, saves and completed-startup resets free of network requests. Prevent content-bearing internal URLs and requests, including preloading and Referer leakage.
- [ ] P4-34 Preserve deliberate HTTP(S) card-link opening with `noopener noreferrer`, no opener and no destination fetching on render/hover/preload. Explain the exception and session lifetime in privacy text.
- [ ] P4-35 Emit the specified meta CSP before scripts with bootstrap hashes and Blob worker support. Keep the main Node app's existing CSP unchanged.
- [ ] P4-36 Configure adapter-static, `.nojekyll`, a dedicated production origin and an empty production base path. Keep analytics and cookies out of the first release.
- [ ] P4-37 Add exact-version release dispatches that create dependency-update PRs and regenerate the lockfile. Validate payload versions, peer/runtime identity and frozen installations.
- [ ] P4-38 Validate final merge candidates, serialize update merges and invalidate stale checks. Record tested commit, package pair and artifact hash; deploy the tested artifact or repeat checks after rebuilding.
- [ ] P4-39 Add nightly checks for the latest published pair and separately for source `main`, without changing production dependencies. Run candidate package checks against the production restoration path before future publication.

## Gate 5 — Acceptance and launch

Run every case in the specification's [demo acceptance checks](web-demo-specification.md#demo-acceptance-checks). The groups below organize execution and evidence; they do not replace individual cases.

- [ ] A-01 Run the shared writable-backend contract suite against HTTP and local backends with equivalent default and non-default contexts. Cover input preparation, errors, namespace creation, transactions and rollback.
- [ ] A-02 Run conditional snapshot cases across HTTP, local and static backends, including cross-instance/namespace validators, reset, replacement and eviction.
- [ ] A-03 Verify active-view refresh, immutable version stamps, cross-namespace mutations, external-process changes, initial poll races, filesystem enrichment and cleanup without a mounted board.
- [ ] A-04 Verify authentication, permissions, malformed error bodies, all Retry-After cases and shared throttling across direct calls and automatic refresh work without mutation replay.
- [ ] A-05 Verify worker termination, rollback errors, lost/late replies, decoding errors, dispatch deadlines, long healthy queue waits, disposal and explicit recovery with no stale publication.
- [ ] A-06 Verify reset during startup, queued/consecutive barriers, failures/retry intent, sample validation, navigation and generation-scoped editor/preferences state with matching resource IDs.
- [ ] A-07 Verify restoration envelopes, timestamps, malformed/corrupt/incompatible copies, valid empty/selection/missing-destination states and deferred deletion. Preserve copies on fallback failures.
- [ ] A-08 Verify all database checks independently with defects outside the initial snapshot, complete-history failures, schema changes/formatting variants and the full compatibility corpus.
- [ ] A-09 Verify sustained writes, delayed exports/storage, revision coverage, save limits, quota/denied storage, stale-copy warnings and reload before/after successful saving.
- [ ] A-10 Verify startup timeout/asset failure distinctions, deployment races, verified-byte execution, cached assets, sample defects, failed finalization and production CSP.
- [ ] A-11 Verify suspension and BFCache during each startup/RPC/save stage, ambiguous repeated heartbeat gaps and stalled health checks. Retain healthy unsaved data without extending deadlines or redispatching work.
- [ ] A-12 Verify browser navigation, delayed hydration/preview suppression, runtime-created namespaces, direct entry/reloads and independent/duplicated tab behavior, including storage denied.
- [ ] A-13 Capture page and worker network traffic. Verify private tags/content never leave through internal URLs, bodies, Referer headers or preload, and only deliberate card-link navigation makes the documented external request.
- [ ] A-14 Verify root, slashless and canonical routes on the deployed GitHub Pages preview, including query/fragment preservation. Do not substitute only local-server checks.
- [ ] A-15 Recheck global CLI installation, existing workspaces/migrations, HTTP compatibility, Node read-only/in-memory modes and existing SSG output.
- [ ] A-16 Exercise overlapping release dispatches and modified merge candidates. Verify a failed update leaves production unchanged and deployment matches the tested commit/artifact.
- [ ] A-17 Implement the versioned performance profile with the specified viewport, CPU/network throttling, pinned Chromium, runner details and identical fixture/baseline artifacts.
- [ ] A-18 Run and retain all 20 cold loads for candidate and baseline. Require p75 FCP within baseline plus 100 ms and trace proof of worker/wasm startup after FCP; missing timings fail the run.
- [ ] A-19 Publish actual wasm sizes and both aspirational timings with fixture, environment, raw timing and trace identifiers. Do not make aspirational targets release blockers.
- [ ] G5 Record all required checks passing, production origin isolation and tested deployment evidence. Launch the demo from that artifact.
