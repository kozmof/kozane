# Kozane client/backend separation and web demo tasks

Use this checklist to implement the [specification](Kozane-Client-Backend-Separation-and-Web-Demo-Specification.md). The specification remains authoritative for behavior, constants and acceptance cases. All tasks start unchecked. Complete each phase and record its gate evidence before starting the next phase. Keep the local app releasable throughout.

Check a task only when its implementation and required verification are complete. Record the PR or commit, check results and artifact locations beside the task or in the gate evidence table. Work may be split into smaller PRs without changing phase dependencies.

The user will run browser end-to-end (E2E) tests after implementation is finished. Browser E2E tests are not available in this environment. Run them in CI and record the CI results as gate evidence. Keep tasks that require browser E2E verification unchecked until the required CI checks pass.

## Preparation

- [ ] PRE-01 Inventory routes, page loaders and CLI commands. Classify each as core-backed, a Node feature or infrastructure. Record current database access and transaction ownership.
- [ ] PRE-02 Inventory client fetch calls, API URL construction, SvelteKit imports, deployment-mode checks, browser globals, preference storage and editor state that must move behind adapters.
- [ ] PRE-03 Capture compatibility baselines for CLI output, HTTP paths, statuses, bodies, messages, ETags, workspace migrations, read-only mode, in-memory mode and SSG output.
- [ ] PRE-04 Pin the pre-extraction static-export baseline revision. Define the benchmark fixture and record how to generate it through existing database APIs.
- [ ] PRE-05 Estimate the verified loader and schema comparison work separately. Record Phase 0 blockers and the decision to proceed or postpone the demo.
- [ ] PRE-06 Mark JSON export, hosted taskspace sessions and changes to `kozane open --memory` as future decisions outside launch scope. Choose the release sample authoring approach before Phase 4 sample generation.

Preparation progress: `source-inventory.md` records route/loader, CLI and client dependency matches. Regenerate with `node scripts/browser-spike/inventory.mjs`. PRE-01 and PRE-02 remain unchecked until each candidate is classified and reviewed.

## Phase 0 — Browser database and loader spike

### Database feasibility

- [ ] P0-01 Build a disposable browser fixture using the existing schema and database APIs. Keep it separate from release sample content.
- [ ] P0-02 Connect `@sqlite.org/sqlite-wasm` in a dedicated worker to Drizzle's `sqlite-proxy` driver without OPFS or COOP/COEP headers.
- [ ] P0-03 Prototype adapter hooks for write and deferred-read transactions, foreign-key initialization and driver-specific operations.
- [ ] P0-04 Run the existing `src/db/api` tests against browser SQLite in a browser runner. Verify pragmas, foreign keys, `RETURNING`, commit and rollback behavior.
- [ ] P0-05 Prototype a queue that serializes complete service operations. Verify overlapping multi-query writes, reads, snapshots, rollback and exports cannot interleave transactions or observe partial changes.

P0-05 progress: `src/lib/backend/operation-queue.ts` implements whole-operation serialization. Three unit tests pass for ordering, rollback completion, rejection recovery and disposal. Formatting and lint pass. Database-backed concurrency and browser verification remain pending.

P0-02/P0-03 progress: disposable worker/proxy spike builds with Vite. A dedicated CI browser test checks in-memory initialization without isolation headers, write transactions, rollback, foreign keys, RETURNING and export. Browser results, existing database API coverage, verified loading and failure recovery remain pending. No additional Phase 0 tasks are checked.

### Verified loading

- [ ] P0-06 Build a minimal production static spike under the specified demo CSP.
- [ ] P0-07 Bundle a self-contained module worker with no runtime imports. Verify its fetched bytes before creating a Blob worker and pass absolute asset URLs.
- [ ] P0-08 Implement the build-ID handshake and an independent responsiveness probe before wasm initialization.
- [ ] P0-09 Fetch wasm once. Compile and hash cloned streams, then make the SQLite loader instantiate only the verified compiled module without another fetch or instantiation.
- [ ] P0-10 Test delayed verification, altered worker and wasm bytes, cold and cached responses, cleanup and production CSP behavior. Open the spike database through this loader.

P0-07/P0-08/P0-09 progress: the spike hashes worker bytes before Blob execution, checks a generated build ID before initialization, and compiles/hashes cloned wasm response streams from one fetch. SQLite instantiates the supplied compiled module. The build and lint pass. CI cases cover altered worker/wasm bytes and mismatched build IDs. Browser execution, deadlines, cleanup failure cases and full loader acceptance remain pending.

P0-10 progress: prototype asset/compilation/RPC deadlines and worker failure cleanup are implemented. Five queue/deadline unit tests pass, and the spike builds. CI cases now include missing assets and an unanswered handshake. Timers still use wall time. Suspension-aware accounting, complete cleanup coverage and browser execution remain pending.

### Schema comparison

Schema comparison progress: `schema-manifest.ts` provides read-only schema SQL, column, foreign-key and index introspection. Two unit tests pass with disposable constraint/index/trigger/view fixtures. `pnpm exec tsx scripts/browser-spike/generate-manifest.ts` generates `tmp/browser-spike/schema-manifest.json` from all bundled migrations. The browser spike now applies every bundled migration and compares schema objects and history hashes/timestamps against a fresh libsql fixture. Seven local queue/deadline/schema tests pass, and the production spike builds. Expanded fixtures detect declared type, nullability, default, primary-key order, check, unique, foreign-key action, index order/direction/predicate, view, trigger and unexpected-object changes. Formatting-only fixtures and SQLite runtime statistics pass comparison. Deterministic sorting no longer depends on locale. All 21 local tests pass; application type/Svelte checks report zero errors and warnings. Full normalization and browser execution remain pending.

- [ ] P0-11 Generate a prototype canonical schema manifest from existing migrations and compare fresh libsql and browser databases without modifying either.
- [ ] P0-12 Cover columns, types, defaults, primary and foreign keys, check and unique constraints, ordered and partial indexes, triggers and views. Add disposable fixtures for features absent from current migrations.
- [ ] P0-13 Define deterministic ordering and SQL normalization. Verify formatting-only differences pass and semantic changes fail while SQLite-owned objects are excluded.
- [ ] P0-14 Check the `kozane` npm organization name and create it under the specified owner and publishing policy, or record the fallback package names.
- [ ] G1 Record passing browser database, concurrency, schema-comparison and verified-loader/CSP checks. Resolve blockers before service extraction or package publication.

## Phase 1 — Shared services and Node adapters

### Core foundations

- [ ] P1-01 Define typed service inputs and results in the modules that will become core services. Start the operation matrix with identifiers, omission/null semantics, transactions, capabilities, invalidations and errors.
- [ ] P1-02 Widen branded database types to the shared async SQLite type. Implement the public adapter factory, read/write hooks and transaction helpers with branding casts confined to core.
- [ ] P1-03 Preserve libsql write and deferred-read behavior in the Node adapter. Isolate libsql-only operations behind adapter hooks.
- [x] P1-04 Implement immutable `ServiceContext` and its factory, preserving existing configuration validation and the 200,000-character default content limit.
  - `src/services/context.ts` exports a frozen context and uses workspace numeric bounds. Nine context tests cover defaults, immutable copies, boundaries, fractional values and invalid numeric values. CLI compilation and 395 focused tests pass. Node caller integration remains part of resource extraction.
- [ ] P1-05 Implement shared JSON-compatible input preparation without invoking getters or `toJSON`. Copy inputs and reject all unsupported values listed in the specification before dispatch.
  - `src/services/prepare-input.ts` copies supported values without invoking accessors or serialization hooks and is applied before writable service body validation. Tests cover unsupported values, cycles, shared noncyclic objects, undefined/null semantics and prototype-looking keys. All 314 service/API tests pass, as do CLI compilation and application typing. Backend pre-dispatch wiring and public exports remain pending with P2/P3.
- [ ] P1-06 Add domain errors and driver normalization after rollback, including commit failures. Invalidate unusable connections and retain safe diagnostic causes.
  - Added transport-free normalization and code-based libsql classification helpers. Five tests cover domain identity, unique constraints, cyclic cause chains, transient lock codes and rollback diagnostic aggregation. CLI compilation and lint pass. Node read/write hooks now own transaction commit, rollback and close, normalize classified failures after rollback, and invalidate/close the client after rollback failure. All 672 database/API tests and three lifecycle tests pass. Commit-failure cleanup and start failures are covered. Unclassified callback errors retain transitional compatibility behavior. Explicit reopening, remaining direct-write paths and browser integration remain pending.
- [ ] P1-07 Add typed `database_content`, `transient` and `unknown` classifications. Keep ordinary mutation constraint failures distinct from confirmed stored-data defects.
  - Typed classification and an internal WeakMap metadata accessor are exported through the database module. Message strings never establish content defects. Ordinary constraint failures remain unknown; failed rollback does not establish corrupt data. Worker envelope propagation and recovery integration remain pending.
- [ ] P1-08 Add a public transaction composition helper and transaction-bound service variants so CLI reference resolution and mutation use the same transaction without nesting.
  - Database module exports `composeWrite`, and card services expose `createInTx` with the same input validation and rules as `create`. CLI card add now resolves namespace/partition/layer/scope and creates the card using that same transaction. Three direct service tests include rollback of reference-resolution work. All 77 card route/service checks, 19 CLI configured-limit subprocess tests, CLI compilation, lint and application typing pass. Card updates now expose `updateInTx`, and CLI text editing resolves the card and performs validation/edit/refit through that service on one transaction handle. Existing CLI inventory-full wording is retained as an adapter mapping with the domain cause preserved. All 97 combined card service/route/CLI-limit tests pass, along with CLI compilation, lint and application typing. Remaining transaction-bound variants and CLI command integration are pending.

P1-02/P1-03 progress: `src/db/database.ts` now owns generic async SQLite database/transaction brands and the public adapter factory with read/write hooks. `src/db/tx.ts` retains libsql immediate-write/deferred-read hooks and Node-only migration access. Existing database API and transaction tests pass unchanged (386 tests across 16 files), CLI compilation passes, and Svelte/type checks report zero errors or warnings. Driver failure normalization and browser adapter verification remain pending.

Service context extension: `canvasWidth` defaults to 5600 and `canvasHeight` defaults to 4000. Both are finite numbers within the existing workspace range of 400–20000, including fractional values. Node adapters pass resolved workspace bounds. Services round clamped card coordinates using these explicit bounds.

Additional P1 progress: shared domain error classes are introduced, preserving existing database error identities. Database API transaction imports now use the transport-free adapter. Error normalization, resource extraction and HTTP integration remain pending.

### Resource extraction

- [ ] P1-09 Extract card services first, including creation, updates, removal, movement, squash, partition/layer changes and stacking.
  - Card creation is extracted into `src/services/cards.ts`, with transport-free validation and batch rejection helpers. The POST route delegates to it and preserves HTTP 400 validation behavior. Existing route/context tests pass (32 tests), lint passes and application type/Svelte checks report zero errors or warnings. Position updates, batch deletion, namespace moves, layer/partition reassignment and stacking are now extracted too. Their HTTP routes delegate to services through a Node workspace-context factory. All 84 card-route/context tests pass, CLI compilation and lint pass, and application type/Svelte checks report zero errors or warnings. Single-card updates/removal and squash now delegate to shared services too. The 84 existing route/context tests pass, plus two direct service tests for configured content boundaries, coordinate clamping and inventory-failure rollback. CLI compilation, lint and application typing pass. CLI transaction composition, error normalization, explicit public declarations and operation-matrix coverage remain pending.
- [ ] P1-10 Extract glue, layer and partition services.
  - HTTP handlers now delegate to `src/services/glues.ts`, `layers.ts` and `partitions.ts`. Services own input validation and layer reorder refusal messages. Duplicate layer/partition names throw `ConflictError`; explicit HTTP compatibility mapping retains status 400 and existing wording. All 31 existing resource route tests pass, lint passes and application type/Svelte checks report zero errors or warnings. Driver normalization, public contract and CLI integration remain pending.
- [ ] P1-11 Extract scope services, including membership and areas.
  - Scope create/rename/removal, membership changes and area create/update/removal now delegate to `src/services/scopes.ts`. Services own input validation and configured rectangle clamping. Existing scope conflict, missing-resource and area error mappings are retained. All 27 existing route tests pass; application type/Svelte checks report zero errors or warnings. Driver normalization, CLI integration and public contracts remain pending.
- [ ] P1-12 Extract warp and inventory services, including inventory take.
  - Warp create/update/removal and inventory create/update/removal/stow/take now delegate to transport-free services. Services validate slots, paired coordinates, names and batches, using explicit canvas settings. All 23 existing resource route tests pass. Combined extracted-resource/context/service checks pass (167 tests across 21 files), application typing reports zero errors or warnings, and lint and CLI compilation pass. CLI compilation now explicitly includes all service modules. Driver normalization, public declarations and CLI integration remain pending.
- [ ] P1-13 Extract snapshot and namespace services. Make namespace creation and default partition/layer initialization atomic without changing the default namespace.
  - Snapshot table reads now delegate to `src/services/snapshot.ts` through one read transaction. Node snapshot assembly retains filesystem enrichment and ETag behavior. Namespace services reuse atomic default partition/layer initialization, and namespace CLI commands now delegate through resolved workspace contexts. All 27 snapshot tests and 5 namespace CLI subprocess tests pass after fixing an import-shadowing issue. CLI compilation, lint and application typing pass. Full transport-free snapshot assembly, public declarations and remaining consumers are pending.
- [ ] P1-14 Extract database-backed tags, map and warp-directory services. Keep filesystem enrichment and caches in Node services.
  - Map datasets, card-tag gathers and warp-directory database rows now live in transport-free services. Existing Node consumers delegate while retaining filesystem enrichment, cache handling and geometry configuration. All 34 existing map/tag/directory tests pass. Browser snapshot assembly is available through `snapshot.get`, with one direct service test passing. CLI compilation, lint and application typing pass. Public contracts, warp-directory geometry context and read-transaction composition remain pending.
- [ ] P1-15 Move all remaining shared validation, clamping and database rules from routes, page loaders and CLI commands into services.

### Compatibility and boundaries

- [ ] P1-16 Convert HTTP handlers to parsing, authentication, service calls and error mapping. Add explicit operation-specific compatibility mappings and `X-Kozane-Error-Code` without changing existing bodies or statuses.
  - Shared domain-code mapping and SvelteKit header assignment are implemented. Adapter tests cover validation/default rows, missing resources, conflicts, limits, unavailable errors, duplicate-name 400 compatibility and authoritative 401/403/429 errors. All 333 API/adapter tests pass, along with CLI compilation, lint and application typing. See `http-error-compatibility.md`. Remaining non-service handlers, complete boundary classification and actual response-header E2E verification are pending.
- [ ] P1-17 Convert CLI commands to shared services while preserving argument parsing, reference resolution, flags and output. Verify concurrent reference changes cannot produce partial card creation or membership.
- [ ] P1-18 Keep filesystem rules in Node services and document infrastructure exemptions.
- [ ] P1-19 Add import and boundary lint checks. Build the prospective core for the browser without Node shims, environment access or SvelteKit imports.
  - `src/services/index.ts` supplies a complete prospective services entry. `pnpm check:core-browser` bundles it with an early resolver rejecting Node builtins and SvelteKit imports and is included in `pnpm verify`. Service lint rejects Node/SvelteKit/server/CLI imports and Node globals. The browser build exposed and removed eleven nested API imports of the Node transaction adapter. The corrected build completes without Node externalization warnings. All 415 database/service tests, CLI compilation and lint pass. Package-level boundaries and final extraction audit remain pending.
- [ ] P1-20 Run existing tests unchanged and add meaningful parity cases for validation, configured limits, clamping, errors, transaction composition and rollback.
- [ ] G2 Record complete route/loader/CLI classification, adapter-only boundaries and passing compatibility checks.

## Phase 2 — UI backend contract

### Public contracts and adapters

- [ ] P2-01 Define every resource API and re-export its input/result types. Complete the operation matrix, including reads, Node-only methods, keepalive behavior and adapter-only test classifications.
- [ ] P2-02 Define `KozaneBackend`, capabilities, backend errors, lifecycle states and immediate state subscriptions.
- [ ] P2-03 Define immutable backend generation/revision stamps and invalidation events. Specify namespace-scoped and workspace-wide effects and update stamps before notifications.
- [ ] P2-04 Define conditional snapshots and opaque validators bound to instance, namespace and generation. Cover eviction and missing namespaces.
- [ ] P2-05 Define public navigation, route, lifecycle and preference-storage adapters that work without SvelteKit in shared runtime modules.
- [ ] P2-06 Implement `HttpBackend`, typed error normalization and existing ETag/304 translation. Preserve the 60 KiB UTF-8 keepalive guard.
- [ ] P2-07 Add internal service-backed endpoints for namespace creation, discovery, tags, map, warp-directory data and workspace change tokens as needed.
- [ ] P2-08 Implement 401/403/429 handling, safe malformed-body fallbacks and one shared monotonic throttle deadline. Coalesce automatic refreshes and require new user action for rejected mutations.
- [ ] P2-09 Implement `StaticBackend` over prerendered snapshots and equivalent view datasets. Reject writes with `read_only` and retain static filesystem results.

### Refresh and UI migration

- [ ] P2-10 Track an instance nonce and one revision per committed outer write transaction for in-memory HTTP databases, covering every retained write path.
- [ ] P2-11 Implement file-backed change tokens using main-file and WAL metadata plus WAL-index headers. Distinguish absent sidecars from read failures and conservatively refresh rollback-journal databases.
- [ ] P2-12 Implement backend-owned visible-document polling, focus refresh, fresh subscription baselines, stale-session rejection and cleanup after the final unsubscribe.
- [ ] P2-13 Revalidate filesystem-enriched active views after successful polls and focus, bypassing stale Node caches. Retain prior data on refresh failure.
- [ ] P2-14 Publish mutation invalidations only after commit. Cover indirect cross-namespace effects or invalidate conservatively across all namespaces.
- [ ] P2-15 Replace `s.fetcher`, direct fetches, API URL construction and deployment-mode branches in components/actions with backend methods and capability checks.
- [ ] P2-16 Move board, namespace discovery/creation, tags, map and warp navigation onto shared backend data and navigation adapters.
- [ ] P2-17 Subscribe before initial reads. Reject superseded or inactive-generation results and disable editing until current data and backend readiness agree.
- [ ] P2-18 Derive HTTP capabilities from resolved Node configuration before SSR. Verify read-only and server-memory lifetime behavior during hydration.
- [ ] P2-19 Verify snapshot validators, cross-namespace invalidations, first-poll races, external CLI writes, taskspace refresh, throttle behavior and unsubscribe cleanup.
- [ ] P2-20 Verify the existing app and SSG retain their URLs, behavior and read-only guarantees.
- [ ] G3 Record complete public declarations/matrix coverage and passing checks that UI modules neither fetch nor construct API URLs.

## Phase 3 — Published packages

### Workspace and artifacts

- [ ] P3-01 Convert the repository to a pnpm workspace with core, client and unscoped CLI packages. Preserve global installation and CLI entry points.
- [ ] P3-02 Add the specified public export maps, packaged declarations and runtime dependency declarations. Keep test-runner dependencies outside runtime entry points.
- [ ] P3-03 Package shared Svelte source with `@sveltejs/package`. Remove source-workspace aliases and SvelteKit dependencies from shared runtime modules.
- [ ] P3-04 Build and ship shared Panda styles, tokens and base styles through `./styles.css`, preserving CSS layer order and stylesheet side effects.
- [ ] P3-05 Declare the exact tested core peer and development dependency in client. Pin tested direct core/client dependencies in consumers and declare the editor's runtime dependencies.

### Migrations and recovery compatibility

- [ ] P3-06 Export immutable ordered migration records with original journal metadata, SQL, Drizzle-compatible hashes and breakpoint-split statements.
- [ ] P3-07 Implement public migration application and explicit prefix/complete history validation with unchanged record format and transaction behavior.
- [ ] P3-08 Preserve the existing Node startup/migration compatibility path separately. Test historical hash mismatches and other previously accepted/rejected histories without rewriting records.
- [ ] P3-09 Generate and export the canonical schema manifest from fresh migrations during core build. Implement read-only comparison using the Phase 0 normalization rules.
- [ ] P3-10 Build the reusable browser restoration harness in this repository using isolated packed consumers and the proven worker/loader. Do not depend on Phase 4 or published candidates.
- [ ] P3-11 Bootstrap the versioned compatibility corpus through candidate public services and supported drivers. Retain original bytes, hashes, producer metadata and expected validation/view outcomes.
- [ ] P3-12 Add same-migration-ID compatibility checks before every core/client publication. Require a new migration ID for intentional stored-data acceptance restrictions and retain discovered regressions.

### Consumer checks and publication

- [ ] P3-13 Verify packed public exports can initialize both adapters, apply migrations, call services and type-check representative calls to every resource API without private imports.
- [ ] P3-14 Verify an isolated plain Svelte consumer without SvelteKit can SSR and hydrate board, tags and map, navigate through supplied adapters and exercise the editor.
- [ ] P3-15 Verify a separate SvelteKit consumer can SSR/prerender and hydrate shared views. Check browser-global safety, initial readiness and hydration consistency.
- [ ] P3-16 Verify stylesheet inclusion, representative computed styles/tokens, editor runtime dependencies and isolated `./testing` imports in production builds.
- [ ] P3-17 Validate one shared core runtime instance and expected versions. Reject missing/incompatible peers and duplicate installations, including same-version duplicates; verify cross-package error identity.
- [ ] P3-18 Run the restoration harness against all available corpus fixtures, including empty/populated workspaces, selection states, cross-namespace data, boundary content and recovery sizes.
- [ ] P3-19 Configure Changesets, public publishing, provenance and release ordering. Build and test packed artifacts for all three packages.
- [ ] G4 Record passing public-consumer, runtime-identity and compatibility-corpus checks, then publish all three initial packages and verify they are installable.

## Phase 4 — Demo implementation

### Repository, sample and navigation

- [ ] P4-01 Create `kozane-demo` with exact published core/client versions and a frozen lockfile. Reuse the verified Phase 0 loader and Phase 3 restoration harness.
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

Run every case in the specification's [demo acceptance checks](Kozane-Client-Backend-Separation-and-Web-Demo-Specification.md#demo-acceptance-checks). The groups below organize execution and evidence; they do not replace individual cases.

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

## Gate evidence

| Gate | Required outcome | Evidence | Status |
| --- | --- | --- | --- |
| G1 | Browser DB, queue, canonical comparison and verified loader work | Pending | Not started |
| G2 | Shared services own rules and transactions; compatibility preserved | Pending | Not started |
| G3 | Complete contracts; UI isolated from transport; SSG preserved | Pending | Not started |
| G4 | Packed consumers and recovery corpus pass; packages published | Pending | Not started |
| G5 | Acceptance, privacy, recovery, hosting, release and performance checks pass | Pending | Not started |
