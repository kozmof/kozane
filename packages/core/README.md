# @kozane/core

Kozane core provides shared rules for reading and changing Kozane data.
Use it in Node or a browser to apply the same validation, placement rules,
and database schema.

Core owns domain types, errors, services, and schema migrations. Your host supplies
the database driver, transaction handling, filesystem access, and presentation.
Each host can choose its environment and reuse the same domain rules.

## What core is for

Core supports three main tasks.

- Build application features with services that validate inputs and change domain data.
- Share types and pure helpers between hosts, including placement previews and tag parsing.
- Create, upgrade, and inspect databases against the bundled migrations and schema.

The package includes JavaScript and TypeScript declarations. Drizzle and UUID are
runtime dependencies. Database drivers belong to the host.

## Where to start

To connect your application to core, follow these steps.

1. Create a Drizzle database handle using the exported schema and your chosen driver.
2. Register the handle with `createDatabaseAdapter` and supply read and write transaction hooks.
3. Create a service context with `createServiceContext` to apply configured write limits.
4. Pass the adapter and context to resource operations from `@kozane/core/services`.
5. Keep filesystem operations and other host I/O in your application.

If core will also apply migrations, provide the optional migration hook described below.
Use pure helpers directly when a feature only needs a local calculation or preview.

### Public entry points

Import from these five entry points. Private module paths are unsupported and may change.

| Entry point               | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `@kozane/core`            | Domain types, errors, limits, and pure helpers                             |
| `@kozane/core/database`   | Adapter registration, transactions, service context, and low-level records |
| `@kozane/core/schema`     | Drizzle tables and relations                                               |
| `@kozane/core/services`   | Resource operations and domain input validation                            |
| `@kozane/core/migrations` | Migration application, history checks, and schema comparison               |

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

Input preparation accepts up to 64 nested object or array containers, counting the
root. Deeper inputs fail with `ValidationError` before dispatch. JSON input preparation
uses stricter prototype checks than the root `isPlainObject` helper, which accepts
non-null objects other than arrays without inspecting their prototypes.

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
