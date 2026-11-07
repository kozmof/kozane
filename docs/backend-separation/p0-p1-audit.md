# P0 and P1 audit

The shared database and service implementations now belong to core. Node owns filesystem and workspace policy. The current source inventory lists all route, loader and CLI adapters with their responsibilities.

## Browser database evidence

Run `pnpm test:db-wasm` to execute the existing database API tests unchanged against SQLite wasm under Node. Run `pnpm test:db-browser` to execute the same files with a dedicated in-memory SQLite worker. These commands substitute only the test database factory and transaction adapter. Schema, table operations, test inputs and assertions stay shared. Migration setup uses the public migration application API and enables foreign keys. Tests cover the current database API modules, large parameter batches, defaults, constraints, RETURNING, card/glue/scope/layer/partition/inventory operations and rollback.

The additional queue case holds a multi-query transaction open while a snapshot, a real SQLite export, a failing write and a final read wait. It verifies that the read sees the complete first write, export follows it, failed writes roll back and later operations still run. The browser fixture does not use OPFS or isolation headers.

The original production spike checks verified worker/wasm hashes, build identity, absent/altered assets, transaction behavior and native/wasm migration-schema parity under the demo CSP. The packed restoration harness extends it with active-time deadlines, suspension and BFCache, independent probes, disposal and stale-reply cleanup. Public migration/schema checks cover declared types, defaults, constraints, indexes, triggers, views, normalization, SQLite statistics and unchanged history bytes. The retained compatibility corpus supplies both native and wasm producers.

The user requested skipping P0 verification during this audit. No further P0 checks are required for this work. The new full browser API run remains unverified. Previous reported browser passes cover the existing spike and packed restoration harness, not this new suite. Gate 1 records verification skipped rather than a passing result. Scope ownership and 2FA were not confirmed because the local npm account is unauthenticated.

## Reviewed P1 boundaries

`pnpm check:adapters` audits all current route, loader and CLI modules. Core-backed frontends may resolve identifiers, parse arguments, shape output and call services. The audit rejects direct SQL writes and adapter-owned write transactions in those modules. Mutation references and service calls share core composition. Lint and standalone browser builds enforce the core/client import boundaries.

Card, glue, layer, partition, scope, warp, inventory, namespace, snapshot, database tags, map and warp-directory rules live in core. Public records support adapter reference lookup and CLI read projections. Those projections retain CLI-specific short IDs, sorting, distances and output formatting. They do not introduce independent domain writes or validation rules.

HTTP handlers retain parsing, authentication and operation-specific status/body/header mappings. Health's `select 1`, migrations, backups/import/restore, startup, diagnostics and workspace initialization are infrastructure. They intentionally retain Node database access. Authentication, configuration, taskspaces, directory/file ownership, path containment and filesystem tag/cache enrichment are Node features.

CLI and HTTP taskspace creation share record insertion, directory claiming and database compensation on failure. Their policies differ deliberately. HTTP creation requires a scope, a new directory and a path inside the workspace. CLI creation supports no scope, adoption, explicit external directories and user-owned paths. Both reuse the same ownership/path primitives. Scan and doctor reconciliation remain Node orchestration because they reconcile filesystem markers with records.

Transaction lifecycle tests cover deferred read snapshots, immediate writes, commit failure rollback, failure to start, rollback failure invalidation and preserved diagnostic causes. Service tests cover configured content/canvas limits, immutable context, safe JSON input preparation, typed failure classification, reference-resolution composition and full batch rollback. Existing HTTP/CLI tests retain status, messages and output behavior. Core compatibility facades preserve error and function identity.

## Completion policy

P1 closes after the source audit and existing native compatibility suites pass. P0 verification is skipped at the user's request. Browser execution and npm account setup remain available follow-up checks before publication. Checking implementation tasks does not claim a new browser run or authorize publication.

The pre-extraction reference is `226facea14e7a9323e4fd6fd1c8d5f4daed76d06`. The earlier inventory hash c31206a already contains service extraction. Performance fixture generation and timed baseline comparisons remain in their preparation and acceptance tasks.
