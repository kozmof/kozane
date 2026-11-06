# @kozane/core

Kozane database contracts, schema and domain services for Node and browsers.

| Export                    | Contents                                                                  |
| ------------------------- | ------------------------------------------------------------------------- |
| `@kozane/core`            | Domain types, service input types and errors                              |
| `@kozane/core/database`   | Adapter factory, branded handles, transaction helpers and service context |
| `@kozane/core/schema`     | Drizzle tables and relations                                              |
| `@kozane/core/services`   | Domain services and input validation                                      |
| `@kozane/core/migrations` | Migration records, application and strict history validation              |

The host supplies its database driver and transaction hooks through the adapter factory.
The package declares Drizzle and UUID as runtime dependencies and includes JavaScript and
TypeScript declarations. Private module paths are unsupported.

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

Build from the repository root with `pnpm build:core`. This regenerates migration records
from the original journal and SQL. Run `pnpm --filter @kozane/core check:migrations` to check
that committed records are current. `pnpm check:core-package` checks freshness, installs the
tarball outside the workspace with only its declared dependencies, checks its public types
and runtime exports, executes its migration statements in native SQLite, and builds its
browser entries.

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

Schema comparison and the remaining workspace conversion are being
completed under [Phase 3](../../docs/backend-separation/Kozane-Client-Backend-Separation-and-Web-Demo-Tasks.md).
