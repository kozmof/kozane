import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createClient } from "@libsql/client";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "../../db/schema.js";
import {
  getMigrationStatus,
  resolveMigrationsFolder,
  type MigrationStatus,
} from "../../db/internal/migrations.js";
import { applyConnectionPragmas, BUSY_TIMEOUT_MS } from "../../db/pragmas.js";
import { dbPath } from "./config.js";

// Read migration state through `db/internal/migrations.ts`, which the server can also import.
// Keep CLI messages and recovery policy here, and re-export the readers for existing callers.
export { getMigrationStatus, resolveMigrationsFolder };
export type { MigrationStatus, MigrationJournalEntry } from "../../db/internal/migrations.js";

function timestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function backupDb(workspaceRoot: string): Promise<string> {
  const source = dbPath(workspaceRoot);
  const backupDir = join(workspaceRoot, ".kozane", "backups");
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
    await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    await client.execute(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    client.close();
  }
  return target;
}

export function listBackups(workspaceRoot: string): string[] {
  const backupDir = join(workspaceRoot, ".kozane", "backups");
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
 * Format migration status and recovery guidance for CLI commands and
 * `requireCurrentMigrations`.
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
 * Stop the command unless all migrations are applied.
 *
 * Require explicit migration so `db migrate` can take a backup and validate migration
 * history. Use `migrationStatusMessage` to recommend a restore for gaps that migration cannot
 * repair.
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
  // Apply the connection timeout used after transactions. See `openDb`.
  const client = createClient({ url: dbUrl, timeout: BUSY_TIMEOUT_MS });
  const db = drizzle(client, { schema });

  try {
    // Use the server's database pragmas, including during initialization, so the workspace
    // uses WAL from its first migration.
    await applyConnectionPragmas(client, dbUrl);
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  } finally {
    client.close();
  }
}

/**
 * Stage a self-contained backup for validation and atomic replacement.
 *
 * Use `VACUUM INTO` so committed rows in a WAL sidecar are included. Copying only the main
 * file can omit recent data or schema changes. An unreadable database fails during staging.
 */
async function stageRestoreCandidate(backupPath: string, stagedPath: string): Promise<void> {
  const client = createClient({ url: `file:${backupPath}` });
  try {
    await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    await client.execute(`VACUUM INTO '${stagedPath.replace(/'/g, "''")}'`);
  } catch (e) {
    throw new Error(
      `Backup is not a recognized Kozane database: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  } finally {
    client.close();
  }
}

async function validateRestoreCandidate(path: string): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  try {
    await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
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
 * Validate and flush the staged backup, then atomically replace the workspace database.
 * Remove old sidecars so SQLite cannot replay the previous database's WAL over the
 * replacement.
 */
export async function restoreDb(backupPath: string, targetPath: string): Promise<void> {
  const stagedPath = `${targetPath}.restore-${process.pid}-${Date.now()}`;
  try {
    await stageRestoreCandidate(backupPath, stagedPath);
    await validateRestoreCandidate(stagedPath);

    const fd = openSync(stagedPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stagedPath, targetPath);
    // Remove old sidecars after replacing the database. A crash before replacement must leave
    // its WAL available.
    for (const sidecar of sidecarPaths(targetPath)) rmSync(sidecar, { force: true });
    const directoryFd = openSync(dirname(targetPath), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    // Validation can create sidecars for the staged copy. Remove those too.
    for (const path of [stagedPath, ...sidecarPaths(stagedPath)]) rmSync(path, { force: true });
  }
}
