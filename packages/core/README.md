# @kozane/core

Kozane core provides shared rules for reading and changing Kozane data.
Use it in Node or a browser to apply the same validation, placement rules,
and database schema.

Core owns domain types, errors, services, and schema migrations. Your host supplies
the database driver, transaction handling, filesystem access, and presentation.
Each host can choose its environment and reuse the same domain rules.

Image reference helpers (`imagePath`, `imageReference`, and `IMAGE_MAX_BYTES`)
are exported from the root entry. Hosts validate and store image bytes. Core
stores the card reference and does not access image files.

## What core is for

Core supports three main tasks.

- Build application features with services that validate inputs and change domain data.
- Share types and pure helpers between hosts, including placement previews and tag parsing.
- Create, upgrade, and inspect databases against the bundled migrations and schema.

The package includes JavaScript and TypeScript declarations. Drizzle and UUID are
runtime dependencies. Database drivers belong to the host.

## Where to start

Connect your application to core with the following steps.

1. Create a Drizzle database handle using the exported schema and your chosen driver.
2. Register the handle with `createDatabaseAdapter` and supply read and write transaction hooks.
3. Create a service context with `createServiceContext` to apply configured write limits.
4. Pass the adapter and context to resource operations from `@kozane/core/services`.
5. Keep filesystem operations and other host I/O in your application.

If core will also apply migrations, provide the optional migration hook described below.
Use pure helpers directly when a feature only needs a local calculation or preview.

### Public entry points

Import from these six entry points. Private module paths are unsupported and may change.

| Entry point               | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `@kozane/core`            | Domain types, errors, limits, and pure helpers                             |
| `@kozane/core/database`   | Adapter registration, transactions, service context, and low-level records |
| `@kozane/core/schema`     | Drizzle tables and relations                                               |
| `@kozane/core/services`   | Resource operations and domain input validation                            |
| `@kozane/core/migrations` | Migration application, history checks, and schema comparison               |
| `@kozane/core/recovery` | Shared reconstruction, content binding and projection validation, local snapshot capture, descriptor storage and asset requirements |

The recovery entry prepares shared projections and local checkpoints for trusted
hosts. It does not enroll a workspace, activate a destination or publish complete
recovery bundles.
Hosts retain the expected descriptor independently of received snapshot data and
own filesystem access and validation database disposal. See
[local recovery snapshots](../../docs/local-recovery-snapshots.md) and
[shared recovery projections](../../docs/shared-recovery-projections.md) for the
current contracts and remaining activation work.

[Shared recovery executions](../../docs/shared-recovery-executions.md) prepare
selected scope records and effect attribution without invoking handlers. Their
descriptors preserve no-op children and invocation image requirements beside the
shared row checkpoint. Trusted descriptors can be retained in a local catalog.
The Node host can retain [saved execution payloads](../../docs/shared-recovery-execution-payloads.md)
after validating both saved source payloads and their original catalog bindings.

[Original recovery actions](../../docs/shared-recovery-actions.md) preserve
first-recorded inputs, bindings, local sequence values and provenance beside
selected executions. Their verification permits changed child inputs while
requiring the original root input and provider map. Trusted action expectations
can be retained in a local catalog with their original source bindings. Original
payloads can be retained by the [Node host](../../docs/shared-recovery-action-payloads.md).
The host can check original invocation images against saved manifests and carry
all five original expectations through image protection.

[Action archives](../../docs/shared-recovery-action-archives.md) prepare
first-recorded roots and descendants outside the current materialization. Their
trusted inventory preserves current originals exactly while retaining additional
inputs, bindings, sequence strings and provenance. Trusted archive descriptors
can be registered with all four original source bindings. Catalog verification
rechecks all five expectations after hashing. The Node host can retain
[saved archive payloads](../../docs/shared-recovery-action-archive-payloads.md)
after validating all four saved sources.
[Run archives](../../docs/shared-recovery-run-archives.md) bind additional roots'
origin, rebase and authoritative runs to those originals. They check each run's
independent context and both SQL endpoints while preserving current selected
contents. Trusted run descriptors can be registered locally with all five
original source bindings. Catalog verification rechecks all six expectations
after hashing. The Node host can retain
[saved run payloads](../../docs/shared-recovery-run-archive-payloads.md) after
validating all saved sources and independent SQL endpoints.
[Run archive asset checkpoints](../../docs/run-archive-asset-checkpoints.md) retain
trusted descriptors in a local catalog and bind per-run and first-recorded input
requirements to those original expectations and the current assets. The Node host can retain
[saved broader manifests](../../docs/run-archive-asset-payloads.md) after validating
all seven saved sources. The
[broader image workflow](../../docs/recovery-checkpoint-images.md#check-saved-broader-run-images)
reserves and verifies their combined requirements while checking all eight
original catalog bindings and files.
[Recovery bundle indexes](../../docs/recovery-bundle-indexes.md) bind all eight
payload references and their exact combined image requirements to an independent
content descriptor. The Node host can
[publish registered bundles](../../docs/recovery-bundles.md) after verifying all
source contents, exact original bindings and protected image bytes. Destination
image installation is described below. Required history and activation remain pending.

[One-time local installation](../../docs/local-recovery-installation.md) stages
exact local rows and a destination-owned record in one commit. It requires an
empty canonical destination and complete migration history. The Node host can
validate a published bundle before this step. Matching retries preserve later
edits. Continue with [shared projection staging](../../docs/shared-recovery-installation.md)
after matching local installation. It preserves current local metadata and commits
exact shared rows with its own immutable destination record. Continue with
destination images below. Required history, bookkeeping and activation remain pending.
[Shared-only staging](../../docs/shared-only-recovery-installation.md) uses an
independently trusted receiving identity and starts without source-device local
attachments. It requires a new empty destination and preserves later edits on
matching retries.
[Destination image installation](../../docs/recovery-image-installation.md)
copies required bytes under committed manifest protection, preserves interrupted
evidence and reuses verified files on retry. History, bookkeeping and activation
remain separate requirements.
[Staged bundle retention](../../docs/staged-recovery-bundles.md) preserves all
eight payloads and their index beside the destination images. The Node loader
revalidates those artifacts without source catalogs or files. Production history
installation and activation remain pending.
[Staged pending-operation inspection](../../docs/recovery-file-operation-inspection.md)
reads exact journal evidence without replay or confirmation. It requires matching
local installation authority and preserves values outside the JavaScript date range.

[Retained recovery history](../../docs/shared-recovery-retained-history.md)
prepares origin, superseded rebase and authoritative runs for selected roots.
It checks each run against its own complete before-state and can validate both
endpoints in isolated SQL databases. Durable complete history retention remains
pending.

Trusted retained-history descriptors can be registered locally with all four
original source bindings. Catalog-backed verification rechecks all five records
after hashing. The Node host can retain
[saved retained-history payloads](../../docs/shared-recovery-retained-payloads.md)
after validating all saved sources and each run's before and after SQL states.
Complete bundles remain pending.

[Retained asset checkpoints](../../docs/retained-recovery-asset-checkpoints.md)
bind per-run and original-input manifests to the retained history and current
asset descriptor. Verification checks all six source payloads and independent
row and invocation coverage before accepting the combined image requirements.
Trusted descriptors can be registered with all six original source bindings.
Catalog-backed verification rechecks all seven records after hashing. The Node
host can retain [saved manifest files](../../docs/retained-recovery-asset-payloads.md)
after validating all six saved sources. The
[image workflow](../../docs/recovery-checkpoint-images.md#check-saved-retained-run-images)
can reserve and verify their combined requirements while checking all seven
original catalog bindings and files. Complete bundles remain pending.

## Application operations

Use resource services for application writes. They own domain validation, configured
limits, and mutations. The `validation` and `guards` namespaces expose checks for
host filesystem adapters. The `rejection` namespace supplies batch validation errors
and messages.

Use `composeWrite` when several operations must commit together. Within its callback,
resolve references and call transaction-bound service variants on the same transaction.
The `records` export provides table-level access through namespaces such as
`records.namespace`, `records.partition`, and `records.card`. It supports reference
lookups and Node compatibility, but does not apply configured service validation.

Layer and partition creation and rename expose `createInTx` and `renameInTx`.
Scopes also expose `createAreaInTx`, `updateAreaInTx`, and `removeAreaInTx`.
Use these variants inside a caller-owned transaction. Their ordinary service
entry points open an adapter write transaction.

Card stacking and squash expose `setStackingInTx` and `squashInTx`.
Layers, partitions and scopes expose `removeInTx`, including each removal's
reassignment or membership cleanup. Namespaces expose `createInTx`, `renameInTx`,
`removeInTx` and `setDefaultInTx`. These variants reuse the caller's transaction.
Ordinary service entry points open one adapter transaction and call the same
implementation. Transaction-bound record variants are available through
`records.card`, `records.composite`, `records.scope` and `records.namespace`.

Scope membership helpers now separate database and transaction handles.
`records.scopeRel.addScopeRel` and `addScopeRels` accept a `DB` and open one
write transaction. Migrate callers that pass a `Tx` to `addScopeRelInTx` or
`addScopeRelsInTx`. These helpers check for existing memberships before inserting,
so duplicate requests do not run insert triggers.

Input preparation accepts up to 64 nested object or array containers, counting the
root. Deeper inputs fail with `ValidationError` before dispatch. JSON input preparation
uses stricter prototype checks than the root `isPlainObject` helper, which accepts
non-null objects other than arrays without inspecting their prototypes.

### Taskspace database records

Use `records.taskspace.addTaskspaceInTx` to create a taskspace label and placement
inside your transaction. Attach directory information separately through
`updateTaskspaceLocationInTx`. Change the label with `updateTaskspaceNameInTx`,
and delete the database record with `deleteTaskspaceInTx`. Your host owns directory
creation, movement and removal.

Location and observation updates preserve `createdAt` and `updatedAt`. A label
request changes `updatedAt` only when the stored name changes. The existing
`addTaskspace` and combined `updateTaskspace` methods remain available. Path-only
calls to the combined update also preserve both timestamps.

Migration 0020 moves paths, path kinds and observations into `taskspace_local`.
The `taskspaceTable` schema export contains shared fields only. Read host views
through taskspace record readers, which join the device's local attachment.
Raw schema consumers can use `taskspaceLocalTable` for local fields.
Deletion retains local metadata for absent taskspaces. Ordinary readers hide
those attachments, and `getAllTaskspaceLocalMetadata` includes them for recovery.
Legacy methods that change both tables use one adapter transaction.

Use the `taskspaces` namespace from `@kozane/core/services` for validated shared
lifecycle operations. `create` requires a namespace, a label and an existing
workspace scope. `rename` and `remove` require namespace visibility. Their `InTx`
variants reuse your transaction. Creation and rename return `SharedTaskspace`
without local attachment fields, and reject path and observation inputs.
These services change shared database rows, and your host owns filesystem work.

## Shared data and helpers

Use the root entry to share domain behavior across application features.

| Need                                    | Exports                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Describe application data               | Entity, board snapshot, taskspace-file, tag, and service input types            |
| Preview inventory placement             | `cardSpan`, `planStow`, and other inventory geometry and layout helpers         |
| Preview splitting and squash placement  | Card splitting and squash placement helpers                                     |
| Parse and group tags                    | `scanTagLines`, `tagMatches`, `buildTagTree`, and related tag helpers           |
| Find text boundaries and display values | `scanUrls`, `applyPalette`, and `compareIds`                                    |
| Apply domain bounds                     | `CONTENT_MAX`, `BATCH_MAX`, `CARD_WIDTH_RANGE`, canvas bounds, and `PATH_KINDS` |
| Validate host file operations           | Taskspace listing/export bounds and `taskspaceNameIssue`                        |
| Share adapter checks                    | `byteLength`, `entryNameIssue`, `errorMessage`, and `isPlainObject`             |

Placement helpers allow previews to follow the same rules as services. Persist changes
through services. Hosts own server settings, gesture thresholds, and filesystem work.
Core's portable domain bounds do not depend on presentation configuration.

## Implement a database adapter

Register each database handle once with `createDatabaseAdapter`. Registration rejects
invalid handles, missing required hooks, and duplicate registration before changing
adapter state. Core owns adapter state and database failure normalization.

The driver hooks define the transaction guarantees on which services depend.

- Resolve only after commit and cleanup finish. Reject failed commits.
- On callback failure, roll back and finish cleanup before rejecting. Preserve the callback error.
- If rollback fails, invalidate the connection before accepting more work.
- Provide one consistent snapshot for the entire read callback.
- Serialize operations that share a connection.
- Never retry callbacks automatically. Callbacks may have external effects.

`ReadTx` exposes query builders without mutation builders or nested transactions.
Raw SQL readers remain trusted interfaces and can execute arbitrary SQL. Hosts must
enforce read-only access through driver or connection configuration. Type brands
separate handles at compile time, while registration and dispatch check required
reader methods at runtime.

For action capture, call `configureActionConnection(execute)` from
`@kozane/core/database` on each native connection before opening a transaction.
Pass an async callback that executes one SQL statement and returns rows with
numeric column indexes. The helper enables and reads back `foreign_keys` and
`recursive_triggers`. SQLite cannot enable foreign keys after a transaction begins.
Use `verifyActionConnection(execute)` to check the settings without changing them.
An unavailable setting raises `ActionConnectionError` with its `pragma` and
`observed` value. Driver failures propagate unchanged. Opt-in action scopes repeat
setup on their transaction connection and verify settings after completion.
Production action capture remains gated on adapter verification and write coverage.

### Migration hook

Migration application requires a separate `migrate(prepare)` hook. Ordinary write
transactions cannot provide its driver-owned boundary.

Invoke `prepare` with the database handle before opening the migration transaction.
It initializes the history table and returns ordered SQL statements with bound arguments.
Execute those statements atomically, disabling foreign keys before the transaction
begins. Restore foreign keys after commit or rollback. Resolve only after commit and
cleanup. Keep preparation and the batch exclusive to that migration operation, and
preserve statement boundaries and bound arguments.

Without this hook, migration application rejects before preparation. Failures propagate without
automatic retries or history repair. Preparation creates the history table outside
the atomic batch, so a failure may leave an empty table. Schema changes and history
inserts within the batch roll back together. Inspect failures before explicitly retrying.
The Node adapter uses the existing native migration batch operation.

## Manage database compatibility

Migration history and schema validation answer different questions. History checks
verify which bundled migrations were recorded. Schema checks verify the database's
actual structure. Integrity and foreign-key checks remain separate requirements.

### Apply and validate migrations

Call `applyMigrations(db)` to apply pending migrations and verify complete history
after commit. Its result includes `schemaVersion` and the IDs applied by that call.
`schemaVersion` is the final bundled migration ID.

Call `validateDatabaseMigrationHistory(db, mode)` to read and validate history in one
read transaction. A missing history table counts as empty and is never created by validation.
Choose the mode explicitly.

| Mode       | Purpose                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `prefix`   | Accept an empty history or a matching contiguous prefix and return pending records |
| `complete` | Require every bundled migration, including when validating a restoration           |

For custom history reads, pass rows ordered by `created_at`, including `hash` and
`created_at`, to `validateMigrationHistory(rows, mode)`. Both modes reject duplicates,
gaps, unknown timestamps, and hash mismatches. The helper never sorts, writes, or
repairs history. `MigrationHistoryError.reason` identifies the failure. The ordinary
Node workspace compatibility path remains separate from these strict checks.

Bundled records preserve journal metadata, original SQL, SHA-256 hashes, and ordered
statements. Statements split only at Drizzle breakpoint markers to preserve trigger bodies.

### Validate the schema

Call `validateDatabaseSchema(db)` to compare the entire database in one read transaction.
It returns a frozen successful comparison or throws `SchemaMismatchError` with
`reason: "schema_mismatch"`. The error's `comparison` lists missing, unexpected, and
altered object keys. Other read failures propagate unchanged. Validation never repairs
or migrates a database.

For custom inspection, pass an async SQL-to-row-array callback to `readSchemaManifest`
inside the driver's read transaction. Compare the result with
`compareSchemaManifests(actual, expected)`. Omitting `expected` uses the deeply frozen
`canonicalSchemaManifest`, generated from a fresh database with all bundled migrations,
including the history table.

The manifest covers tables, columns, declared types, nullability, defaults, primary
and foreign keys, constraints, indexes, triggers, and views. Objects use SQLite binary
ordering by type and name. Columns retain ordinal order, foreign keys use ID and
sequence order, and index shapes sort by their JSON representation. Index shapes omit
implicit names but retain ordered columns, uniqueness, origin, and partial flags.
SQLite-owned objects whose names begin with `sqlite_` are excluded. Other extra objects
are rejected.

`normalizeSchemaSql` removes whitespace and comments outside quoted tokens and trailing
statement terminators. It preserves token spelling, case, quoting, literals, operators,
and expressions. Declared types and defaults use the same normalization. Constraints,
partial predicates, triggers, and views retain their normalized SQL definitions.

## Develop and verify core

Run commands from the repository root.

| Task                                                      | Command                                                  |
| --------------------------------------------------------- | -------------------------------------------------------- |
| Check committed migration inputs and build core           | `pnpm build:core`                                        |
| Generate SQL and refresh core inputs after schema changes | `pnpm db:generate`                                       |
| Refresh core inputs from existing SQL                     | `pnpm --filter @kozane/core migrations:refresh`          |
| Check committed migration records                         | `pnpm --filter @kozane/core check:migrations`            |
| Check the canonical schema manifest                       | `node packages/core/scripts/generate-schema.mjs --check` |
| Verify the installed core package and adapter contracts   | `pnpm check:core-package`                                |
| Verify client package compatibility                       | `pnpm test:client-package`                               |

Run `pnpm check:core-package` for every adapter change. Add host-specific failure
injection checks for commit and rollback. Before releasing API boundary changes, run
both package checks, review exported declarations, and record intentional changes in
a changeset. Removing or changing exports requires a compatibility review.

The core package check installs an isolated tarball with declared dependencies and
explicit driver dependencies. It checks public types and runtime exports, browser
bundles, migrations, schema compatibility, upgrades, relation preservation, rollback,
and driver commit boundaries. Packed libsql and sqlite-wasm consumers exercise public
adapter hooks, writes, nullable updates, missing reads, and rollback. Schema checks
also run against native SQLite. Packed checks reject UI configuration in the archive.

The repository builds core before checking, testing, or building consumers. Node
builds keep core external and check that schema objects, adapter state, and error
constructors are shared with the installed package. Package smoke checks install the
core candidate alongside the CLI candidate for local and global installs.

### Release preparation

`prepublishOnly` runs `release:check:core`. It packs isolated core and client candidates,
checks retained corpus bytes and outcomes through both packages, and runs client style
and restoration Chromium suites. This requires repository development dependencies,
the pinned Chromium installation, and full Git history for corpus retention checks.
Earlier corpus records must remain unchanged.

See the [corpus workflow](../../tests/compatibility/README.md),
[verification guidance](../../docs/verification.md), and
[local release guide](../../docs/releases.md) for maintenance and publication procedures.
