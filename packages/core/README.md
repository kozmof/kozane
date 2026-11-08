# @kozane/core

Kozane database contracts, schema and domain services for Node and browsers.

| Export                    | Contents                                                        |
| ------------------------- | --------------------------------------------------------------- |
| `@kozane/core`            | Domain types, errors and shared domain helpers                  |
| `@kozane/core/database`   | Adapter factory, transactions, service context and table APIs   |
| `@kozane/core/schema`     | Drizzle tables and relations                                    |
| `@kozane/core/services`   | Domain services and input validation                            |
| `@kozane/core/migrations` | Migration application, history validation and schema comparison |

The host supplies its database driver and transaction hooks through the adapter factory.
The package declares Drizzle and UUID as runtime dependencies and includes JavaScript and
TypeScript declarations. Private module paths are unsupported.

Import entity, board snapshot, taskspace-file and tag types from `@kozane/core`.
These declarations share the schema and adapter types supplied by the package.

The root entry also exports inventory geometry and layout helpers such as `cardSpan` and
`planStow`, plus card splitting and squash placement helpers. Use these for local placement
previews that follow the same rules as database services. Mutations remain in
`@kozane/core/services`.

Import `scanTagLines`, `tagMatches` and `buildTagTree` from the root entry to use the shared
tag grammar and grouping rules. It also exports `scanUrls` for text boundaries, `applyPalette`
for partition colors and `compareIds` for stable ID ordering.

Domain limits and defaults are available from the root entry, including `CONTENT_MAX`,
`BATCH_MAX`, `CARD_WIDTH_RANGE`, canvas bounds and `PATH_KINDS`. Use `createServiceContext`
from `@kozane/core/database` to apply configured write limits. The host owns server settings
and gesture thresholds.

Taskspace listing/export bounds and `taskspaceNameIssue` are also exported from the root
entry. Hosts perform filesystem operations using these shared limits and name checks.

The root entry also exports `byteLength`, `entryNameIssue`, `errorMessage` and `isPlainObject`
for shared adapter checks. `isPlainObject` accepts non-null objects other than arrays and
does not inspect prototypes. JSON input preparation through services applies its own
stricter prototype checks.

Import `records` from `@kozane/core/database` for table-level reference lookups and Node
compatibility. Its namespaces include `records.namespace`, `records.partition` and
`records.card`. Use `composeWrite` to resolve references and invoke a transaction-bound
service on one write transaction. Resource services own configured validation and mutations.

Import resource operations from `@kozane/core/services`. The `validation` and `guards`
namespaces provide the same checks for host filesystem adapters. The `rejection` namespace
provides batch validation errors and their messages. Keep host I/O outside these services
and pass the database adapter and service context to each operation.

Migration records preserve the journal ID, tag, index, timestamp, journal version and
breakpoint flag. Each record contains its original SQL, SHA-256 hash and ordered statements.
Statements split only at Drizzle breakpoint markers, preserving trigger bodies. The
`schemaVersion` export is the final migration ID.

Read history rows from the candidate database ordered by `created_at`, including `hash` and
`created_at`, before calling `validateMigrationHistory(rows, mode)`. Choose the mode explicitly.
`prefix` accepts an empty history or a matching contiguous prefix and returns the pending
records. `complete` requires every bundled migration and is required for restoration.
Both modes reject duplicates, gaps, unknown timestamps and hash mismatches. The helper never
sorts, writes or repairs history. `MigrationHistoryError.reason` identifies the failure.
The ordinary Node workspace compatibility path remains separate from these strict checks.

Build from the repository root with `pnpm build:core`. This checks committed migration records
and the canonical schema before compiling. Run `pnpm db:generate` after changing the
application schema to generate SQL and refresh both committed core inputs. Run
`pnpm --filter @kozane/core migrations:refresh` to refresh them from existing SQL. Run `pnpm --filter @kozane/core check:migrations` to check
that committed records are current. `pnpm check:core-package` checks freshness, installs the
tarball outside the workspace with its declared dependencies and the adapter fixtures’ explicit
Drizzle and sqlite-wasm dependencies. It checks public types and runtime exports, applies migrations through a
SQLite proxy adapter, compares history and application schema with the existing Node migrator,
and builds the browser entries. It also checks upgrades, relation preservation, rollback,
read-only history validation and driver commit boundaries. Schema checks run against native
SQLite and sqlite-wasm under Node. Browser runtime entries are bundled separately.

Call `validateDatabaseMigrationHistory(db, mode)` to read and validate history in one read
transaction. A missing history table counts as empty and is never created by validation.
Call `applyMigrations(db)` to apply the pending prefix and verify complete history after commit.
The result contains `schemaVersion` and the IDs applied by that call.

Provide the optional `migrate(prepare)` adapter hook to support application. Invoke `prepare`
with the database handle before opening the migration transaction. It initializes the history
table and returns ordered SQL statements with bound arguments. Execute those statements
atomically with foreign keys disabled before the transaction begins. Restore foreign keys
after commit or rollback, and resolve the hook only after commit. Keep preparation and the
batch exclusive to that migration operation. Preserve statement boundaries and bound arguments.
Ordinary write transactions cannot provide this boundary. An adapter without the hook rejects
application before preparation. Failures propagate without automatic retries or history repair.
The Node adapter uses the existing native migration batch operation.

The schema generator applies bundled migrations to a fresh database and generates
`canonicalSchemaManifest`, including the history table. Run
`node packages/core/scripts/generate-schema.mjs --check` to check freshness.
The manifest is deeply frozen. It covers table definitions, columns, declared types,
nullability, defaults, primary and foreign keys, constraints, indexes, triggers and views.

Call `validateDatabaseSchema(db)` to compare an entire database in one read transaction.
It returns a frozen successful comparison or throws `SchemaMismatchError` with
`reason: "schema_mismatch"` and a `comparison` containing missing, unexpected and altered
object keys. Other read failures propagate without becoming schema mismatches. History,
integrity and foreign-key checks remain separate requirements. Schema validation never
repairs or migrates a database.

For custom inspection, pass an async SQL-to-row-array callback to `readSchemaManifest`.
Compare its output with `compareSchemaManifests(actual, expected)`. Omit `expected` to use
the canonical manifest. Keep custom inspection inside the driver's read transaction.

Schema objects are ordered by SQLite's binary ordering of type and name. Columns retain
ordinal order, foreign keys use ID and sequence order, and index shapes sort by their JSON
representation. Implicit index names are excluded from index shapes. Ordered index columns,
uniqueness, origin and partial flags remain. SQLite-owned objects with names beginning
`sqlite_`, including runtime statistics, are excluded. Other extra objects are rejected.
`normalizeSchemaSql` removes whitespace and comments outside quoted tokens and trailing
statement terminators. It preserves token spelling, case, quoting, literals, operators and
expressions. Declared types and column defaults use the same normalization. Constraints,
partial predicates, triggers and views retain their normalized SQL definitions.

Before source publication, `prepublishOnly` runs the repository's `release:check:core`
command. It packs isolated core/client candidates, validates retained corpus bytes and
outcomes through both packages, and runs the client style and restoration Chromium suites. The retention check requires full Git history
and prevents rewriting earlier corpus records. See the
[corpus workflow](../../tests/compatibility/README.md). This source-release command requires
the repository's development dependencies and pinned Chromium installation.

Packed checks also initialize libsql and sqlite-wasm through public adapter hooks. Both
apply migrations, validate history/schema and exercise service writes, nullable updates,
missing reads and transaction-bound rollback. Driver dependencies belong to the isolated
consumer and are not added to core runtime dependencies.

Write validation and workspace configuration share portable domain bounds for card width,
content limits and canvas dimensions. Core services use these bounds without importing
presentation configuration. Packed checks reject UI configuration files in the core archive.

Schema, adapter state, database failure normalization and domain error classes are owned
by this package. The Node compatibility modules forward through public exports.
The root package builds core before checking, testing or building consumers. Node server
builds keep core external, and the compiled Node check verifies shared schema objects,
adapter state and error constructors against the installed version. Package smoke checks
install the candidate core tarball alongside the CLI tarball for local and global installs.

See the [local release guide](../../docs/releases.md) for package preparation and publication.

Adapter hooks must resolve only after commit and reject after rollback. Keep read
transactions consistent for the entire callback. Register each database handle once.
Registration rejects missing hooks and duplicate handles before changing adapter state.

Migration preparation creates the history table outside the atomic batch. If preparation
or batch execution fails, that empty table can remain. Schema changes and history inserts
inside the batch roll back together. Inspect the failure before explicitly retrying.

## Choose an operation layer

Use resource services for application writes. Services apply configured limits and
validate domain inputs. Use transaction-bound service variants inside composeWrite.
The records export provides low-level access for reference resolution and compatibility.
Calling it directly does not provide configured service validation.

ReadTx exposes query builders without mutation builders or nested transactions.
Raw SQL readers remain trusted interfaces and cannot enforce read-only SQL.
Input preparation accepts up to 64 nested object or array containers, counting the
root. Deeper input fails with ValidationError before dispatch.

## Implement an adapter

Resolve hooks only after commit and cleanup finish. Reject failed commits.
When a callback fails, roll back and finish cleanup before rejecting. Preserve the
callback error. If rollback fails, invalidate the connection before accepting more
work. Read hooks must provide one consistent snapshot. Serialize operations that
share a connection. Never retry callbacks automatically.

Run `pnpm check:core-package` for every adapter change. Its isolated libsql and
sqlite-wasm consumers exercise migrations, committed writes and rollback through
public exports. Add host-specific failure injection checks for commit and rollback.
See [verification guidance](../../docs/verification.md) for checks by change type.

## Choosing an API boundary

Use the root entry for domain data and helpers, and resource services for validated
application writes. Use `composeWrite` when several service operations must commit
together. Keep imports on the five public entry points listed above; internal paths
can change between releases.

Database adapters are trusted infrastructure. Handle validation checks the required
reader methods at registration and transaction dispatch. Type brands distinguish
handles during compilation; raw SQL reader methods still execute trusted SQL.
Hosts must enforce read-only access through their driver or connection configuration.
Adapter hooks must await commit or rollback and cleanup before settling, serialize
shared connections, and never automatically retry callbacks with external effects.

Before releasing changes to these boundaries, run `pnpm check:core-package` and
`pnpm test:client-package` from the repository root. These checks exercise installed
package entry points and adapter behavior. Review exported declarations for API
changes and record intentional changes in a changeset. Preserve existing entry
points when adding APIs; removing or changing an export requires a compatibility
review.
