import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createClient } from "@libsql/client";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "../../db/schema.js";
import { resolveMigrationsFolder } from "../../db/internal/migrations.js";
import { dbPath } from "./config.js";

export { resolveMigrationsFolder };

type MigrationJournal = {
  entries: MigrationJournalEntry[];
};

type MigrationJournalEntry = {
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

function timestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function backupDb(projectRoot: string): Promise<string> {
  const source = dbPath(projectRoot);
  const backupDir = join(projectRoot, ".kozane", "backups");
  mkdirSync(backupDir, { recursive: true });

  const base = join(backupDir, `kozane-${timestamp()}`);
  let target = `${base}.db`;
  let suffix = 2;
  while (existsSync(target)) {
    target = `${base}-${suffix}.db`;
    suffix += 1;
  }

  // VACUUM INTO produces a consistent copy even under concurrent writes, unlike copyFileSync.
  const client = createClient({ url: `file:${source}` });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    client.close();
  }
  return target;
}

export function listBackups(projectRoot: string): string[] {
  const backupDir = join(projectRoot, ".kozane", "backups");
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => f.endsWith(".db"))
    .sort()
    .map((f) => join(backupDir, f));
}

function migrationLabel(migration: { tag: string; when: number } | null): string {
  return migration ? `${migration.tag} (${migration.when})` : "none";
}

/**
 * A migration status as the CLI reports it, and the way out of it.
 *
 * Here rather than beside a command because three commands print it and one library
 * function does — `requireCurrentMigrations` below. It used to live in `commands/db.ts`,
 * which made `open` and `ssg` import from a sibling command module to get at it, and put
 * it out of reach of anything in `lib/` entirely.
 */
export function migrationStatusMessage(status: MigrationStatus): string {
  const lines = [
    `Database: ${status.dbPath ?? "unknown"}`,
    `Status  : ${status.state}`,
    `Latest  : ${migrationLabel(status.latest)}`,
  ];
  if (status.state !== "unknown") {
    lines.push(`Applied : ${migrationLabel(status.applied)}`);
  }

  if (status.state === "pending") {
    lines.push(`Pending : ${status.pendingCount}`);
    lines.push(`Run     : kozane db migrate`);
  } else if (status.state === "gapped") {
    lines.push(`Pending : ${status.pendingCount}`);
    lines.push(`Skipped : ${status.skipped.map((entry) => entry.tag).join(", ")}`);
    lines.push(`Detail  : migrations were applied out of order or a record was lost`);
    lines.push(`Try     : kozane db restore  (kozane db migrate cannot repair this)`);
  } else if (status.state === "missing") {
    lines.push(`Detail  : database file is missing`);
  } else if (status.state === "unknown") {
    lines.push(`Detail  : ${status.error}`);
    lines.push(`Try     : kozane doctor`);
  }

  return lines.join("\n");
}

/**
 * Stops the command unless every migration is applied.
 *
 * The one rule for schema drift, so that a workspace left behind by an upgrade fails the
 * same way whichever command reaches it first. `kozane open` and `kozane net ssg generate`
 * already refused this way; the workspace commands did not, and split three ways instead —
 * `layer add`, `scope add` and `project create` called {@link runMigrations} outright,
 * while `card add`, `taskspace create` and the rest went straight at the stale schema and
 * failed with whatever SQLite said about a missing column.
 *
 * Migrating here was the worse of the two. `kozane db migrate` takes a backup first and
 * refuses a gapped history; a bare `runMigrations` on the way into an unrelated command
 * does neither, so the one operation the docs promise is backed up was also the one that
 * could happen without anybody asking for it.
 *
 * Never suggests `db migrate` for a state it cannot repair: a gapped history needs a
 * restore, and `migrationStatusMessage` says so.
 */
export async function requireCurrentMigrations(dbUrl: string, purpose: string): Promise<void> {
  const status = await getMigrationStatus(dbUrl);
  if (status.state === "current") return;

  console.error(`Kozane database needs attention before ${purpose}.`);
  console.error(migrationStatusMessage(status));
  if (status.state === "pending") {
    console.error("\nRun: kozane db migrate");
  } else {
    console.error("\nRun: kozane db status");
    console.error("Run: kozane doctor");
  }
  process.exit(1);
}

export async function runMigrations(dbUrl: string): Promise<void> {
  const client = createClient({ url: dbUrl });
  const db = drizzle(client, { schema });

  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  } finally {
    client.close();
  }
}

async function validateRestoreCandidate(path: string): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    const result = await client.execute("PRAGMA integrity_check");
    if (result.rows.length !== 1 || result.rows[0]?.integrity_check !== "ok") {
      throw new Error("SQLite integrity check failed");
    }
  } finally {
    client.close();
  }

  const status = await getMigrationStatus(`file:${path}`);
  if (
    status.state === "missing" ||
    status.state === "unknown" ||
    status.state === "gapped" ||
    (status.state === "pending" && status.applied === null)
  ) {
    const detail = status.state === "unknown" ? `: ${status.error}` : "";
    throw new Error(`Backup is not a recognized Kozane database${detail}`);
  }
}

/**
 * The files SQLite keeps beside a database file, which anything replacing one has to
 * account for. A write-ahead log holds committed transactions that are not yet in the main
 * file, so a `-wal` left beside a database that has been swapped underneath it describes a
 * history that database never had.
 */
function sidecarPaths(dbFile: string): string[] {
  return [`${dbFile}-wal`, `${dbFile}-shm`];
}

/**
 * Validate a backup, flush it, then atomically replace the workspace database.
 *
 * The rename alone is not the whole replacement. Nothing here sets `journal_mode`, so the
 * mode is the driver's to choose and may change under us; in WAL, the file being replaced
 * has a `-wal` beside it holding commits the main file does not, and SQLite would go on
 * replaying that log over the restored database. The result is neither the backup nor what
 * was there before. Removing the sidecars is correct in every journal mode — in the others
 * there are none to remove — so this does not depend on knowing which one is in force.
 */
export async function restoreDb(backupPath: string, targetPath: string): Promise<void> {
  const stagedPath = `${targetPath}.restore-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(backupPath, stagedPath);
    await validateRestoreCandidate(stagedPath);

    const fd = openSync(stagedPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stagedPath, targetPath);
    // After the rename rather than before: until the new file is in place there is still a
    // database here that its log belongs to, and a crash between the two would otherwise
    // leave the *old* database stripped of commits it had.
    for (const sidecar of sidecarPaths(targetPath)) rmSync(sidecar, { force: true });
    const directoryFd = openSync(dirname(targetPath), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    // The staged copy is opened by `validateRestoreCandidate`, which is enough to give it
    // sidecars of its own; they are no part of the restored database either way.
    for (const path of [stagedPath, ...sidecarPaths(stagedPath)]) rmSync(path, { force: true });
  }
}
