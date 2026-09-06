import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** What a migrations folder must contain for this to have found the right one. */
function isMigrationsFolder(candidate: string): boolean {
  return existsSync(join(candidate, "meta", "_journal.json"));
}

/**
 * Absolute path to the bundled `drizzle/` migrations folder.
 *
 * Resolved from this module rather than from `process.cwd()` so migrations are found
 * whichever directory a command runs in.
 *
 * Found by walking up rather than by counting directories, and that is a fix rather than a
 * flourish. It used to be `resolve(here, "../../..")` — correct for `src/db/internal` and
 * `dist/db/internal`, which both sit three below the package root, and wrong the moment
 * anything else imports this module. Vite is the anything else: it bundles the server hooks
 * into `build/server/chunks/entries/`, so the same arithmetic landed on `<root>/build/drizzle`
 * and the schema gate in `hooks.server.ts` answered every request with a 503 about a journal
 * that was never there. Nothing caught it, because the source layouts the tests run under are
 * exactly the two the arithmetic was written for.
 *
 * So the depth is not assumed. Each ancestor is asked whether it holds a `drizzle/` with a
 * journal in it, which is the question the caller actually has, and the first that does wins.
 * That is a handful of `existsSync` calls on a path a few levels deep, once per process in
 * practice.
 *
 * `KOZANE_MIGRATIONS_DIR` overrides it outright, for a layout that defeats the walk — a
 * bundler that inlines this file somewhere unrelated to the package, say. Nothing sets it;
 * it exists so that being wrong here is recoverable without a release.
 */
export function resolveMigrationsFolder(): string {
  const override = process.env.KOZANE_MIGRATIONS_DIR;
  if (override) return resolve(override);

  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (true) {
    const candidate = join(dir, "drizzle");
    if (isMigrationsFolder(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Nothing found. Answered with the historical guess rather than by throwing, so the caller
  // reports a missing journal the way it always did — `getMigrationStatus` turns it into an
  // `"unknown"` status, and `kozane doctor` into a check — instead of this throwing from
  // inside an import.
  return join(resolve(here, "../../.."), "drizzle");
}

/**
 * Reading a database's migration state, as opposed to acting on it.
 *
 * Here rather than in `cli/lib/db.ts`, where it began, because it has two audiences now and
 * they sit on opposite sides of the tree. The CLI reports it and offers a way out — that
 * half is still there, in `migrationStatusMessage` and `requireCurrentMigrations`, and it
 * ends in `process.exit`, which a server cannot do. The server needs the same *answer* to
 * refuse a request against a schema it cannot serve, and reaching into `src/cli` for it
 * would point the dependency the wrong way round.
 *
 * So what moved is the part with no policy in it: read the journal, ask the database what it
 * has applied, and say which of the five states that is. What to do about each is left to
 * the caller, which is what lets the CLI exit and the server answer 503.
 *
 * `cli/lib/db.ts` re-exports these, so the commands that already named them still can.
 */

type MigrationJournal = {
  entries: MigrationJournalEntry[];
};

export type MigrationJournalEntry = {
  idx: number;
  when: number;
  tag: string;
};

export type MigrationStatus =
  | {
      state: "missing";
      dbPath: string | null;
      latest: MigrationJournalEntry | null;
      applied: null;
      pendingCount: number;
    }
  | {
      state: "current";
      dbPath: string | null;
      latest: MigrationJournalEntry | null;
      applied: MigrationJournalEntry | null;
      pendingCount: 0;
    }
  | {
      state: "pending";
      dbPath: string | null;
      latest: MigrationJournalEntry;
      applied: MigrationJournalEntry | null;
      pendingCount: number;
    }
  // Migrations were applied out of order or a row was lost: the database records
  // a migration newer than one it never applied. `kozane db migrate` cannot repair
  // this, because drizzle only applies migrations newer than the newest recorded one.
  | {
      state: "gapped";
      dbPath: string | null;
      latest: MigrationJournalEntry | null;
      applied: MigrationJournalEntry | null;
      pendingCount: number;
      skipped: MigrationJournalEntry[];
    }
  | {
      state: "unknown";
      dbPath: string | null;
      latest: MigrationJournalEntry | null;
      error: string;
    };

function readMigrationJournal(): MigrationJournal {
  const journalPath = join(resolveMigrationsFolder(), "meta", "_journal.json");
  const parsed: unknown = JSON.parse(readFileSync(journalPath, "utf-8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error(`Invalid migration journal at ${journalPath}`);
  }

  const entries = (parsed as { entries: unknown[] }).entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { idx?: unknown }).idx !== "number" ||
      typeof (entry as { when?: unknown }).when !== "number" ||
      typeof (entry as { tag?: unknown }).tag !== "string"
    ) {
      throw new Error(`Invalid migration journal entry at ${journalPath}`);
    }
    return entry as MigrationJournalEntry;
  });

  return { entries };
}

function latestMigration(entries: MigrationJournalEntry[]): MigrationJournalEntry | null {
  return entries.at(-1) ?? null;
}

function migrationByWhen(
  entries: MigrationJournalEntry[],
  createdAt: number | null,
): MigrationJournalEntry | null {
  if (createdAt === null) return null;
  return entries.find((entry) => entry.when === createdAt) ?? null;
}

/** SQLite returns `created_at` as a number, bigint, or string depending on the driver path. */
function toTimestamp(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string"
          ? Number(value)
          : null;
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

function pathFromDbUrl(dbUrl: string): string | null {
  if (!dbUrl.startsWith("file:")) return null;
  return dbUrl.slice("file:".length);
}

export async function getMigrationStatus(dbUrl: string): Promise<MigrationStatus> {
  let entries: MigrationJournalEntry[];
  let latest: MigrationJournalEntry | null;
  try {
    entries = readMigrationJournal().entries;
    latest = latestMigration(entries);
  } catch (e) {
    return {
      state: "unknown",
      dbPath: pathFromDbUrl(dbUrl),
      latest: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const filePath = pathFromDbUrl(dbUrl);
  if (filePath && !existsSync(filePath)) {
    return {
      state: "missing",
      dbPath: filePath,
      latest,
      applied: null,
      pendingCount: entries.length,
    };
  }

  const client = createClient({ url: dbUrl });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    const table = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      args: ["__drizzle_migrations"],
    });
    const hasMigrationTable = table.rows.length > 0;
    // Every applied timestamp is read, not just the newest one: a database that is
    // missing an interior migration still has a newest row, and reporting on that
    // alone would call an incomplete schema "current".
    const appliedRows = hasMigrationTable
      ? await client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at ASC")
      : null;
    const appliedWhens = new Set(
      (appliedRows?.rows ?? []).map((row) => {
        const value = toTimestamp(row.created_at);
        if (value === null) throw new Error("Invalid latest applied migration timestamp");
        return value;
      }),
    );
    const newestApplied = appliedWhens.size > 0 ? Math.max(...appliedWhens) : null;

    const applied = migrationByWhen(entries, newestApplied);
    const notApplied = entries.filter((entry) => !appliedWhens.has(entry.when));
    const skipped =
      newestApplied === null ? [] : notApplied.filter((entry) => entry.when < newestApplied);
    const pending = notApplied.filter(
      (entry) => newestApplied === null || entry.when > newestApplied,
    );

    if (skipped.length > 0) {
      return {
        state: "gapped",
        dbPath: filePath,
        latest,
        applied,
        pendingCount: pending.length,
        skipped,
      };
    }

    if (pending.length === 0 || !latest) {
      return { state: "current", dbPath: filePath, latest, applied, pendingCount: 0 };
    }

    return {
      state: "pending",
      dbPath: filePath,
      latest,
      applied,
      pendingCount: pending.length,
    };
  } catch (e) {
    return {
      state: "unknown",
      dbPath: filePath,
      latest,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    client.close();
  }
}
