import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** What a migrations folder must contain for this to have found the right one. */
function isMigrationsFolder(candidate: string): boolean {
  return existsSync(join(candidate, "meta", "_journal.json"));
}

/**
 * Find the bundled migrations directory by walking ancestors of this module. This supports
 * source, CLI, and server bundle layouts without assuming a fixed depth or working directory.
 *
 * `KOZANE_MIGRATIONS_DIR` overrides discovery for other layouts.
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

  // Return the fallback path when discovery fails so callers report an unknown migration
  // state instead of throwing during import.
  return join(resolve(here, "../../.."), "drizzle");
}

/**
 * Read migration state for both CLI and server callers. Leave recovery policy to them so the
 * CLI can exit while the server returns a response. `cli/lib/db.ts` re-exports these readers.
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
  // Migration cannot fill a history gap once a newer migration is recorded.
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
    // Read every timestamp to detect gaps within migration history.
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
