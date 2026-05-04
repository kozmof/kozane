import { resolve } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbPath, dbUrl } from "../lib/config.js";
import { backupDb, getMigrationStatus, runMigrations, type MigrationStatus } from "../lib/db.js";

function migrationLabel(migration: { tag: string; when: number } | null): string {
  return migration ? `${migration.tag} (${migration.when})` : "none";
}

export function migrationStatusMessage(status: MigrationStatus): string {
  const lines = [
    `Database: ${status.dbPath ?? "unknown"}`,
    `Status  : ${status.state}`,
    `Applied : ${migrationLabel(status.applied)}`,
    `Latest  : ${migrationLabel(status.latest)}`,
  ];

  if (status.state === "pending") {
    lines.push(`Pending : ${status.pendingCount}`);
    lines.push(`Run     : kozane db migrate`);
  } else if (status.state === "missing") {
    lines.push(`Detail  : database file is missing`);
  } else if (status.state === "unknown") {
    lines.push(`Detail  : ${status.error}`);
    lines.push(`Try     : kozane doctor`);
  }

  return lines.join("\n");
}

export async function dbStatus(): Promise<void> {
  const { root } = requireWorkspace();
  const status = await getMigrationStatus(dbUrl(resolve(root)));
  console.log(migrationStatusMessage(status));

  if (status.state !== "current") process.exit(1);
}

export async function dbMigrate(): Promise<void> {
  const { root } = requireWorkspace();
  const projectRoot = resolve(root);
  const url = dbUrl(projectRoot);
  const status = await getMigrationStatus(url);

  if (status.state === "current") {
    console.log("Database is already current.");
    console.log(migrationStatusMessage(status));
    return;
  }

  if (status.state === "missing") {
    console.error(`Database file is missing: ${dbPath(projectRoot)}`);
    process.exit(1);
  }

  if (status.state === "unknown") {
    console.error("Cannot determine database migration status.");
    console.error(migrationStatusMessage(status));
    process.exit(1);
  }

  let backupPath: string;
  try {
    backupPath = backupDb(projectRoot);
  } catch (e) {
    console.error("Failed to create database backup.");
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  console.log(`Backup created: ${backupPath}`);

  try {
    await runMigrations(url);
  } catch (e) {
    console.error("Migration failed.");
    console.error(e instanceof Error ? e.message : String(e));
    console.error(`Backup remains at: ${backupPath}`);
    process.exit(1);
  }

  const nextStatus = await getMigrationStatus(url);
  console.log("Database migrated.");
  console.log(migrationStatusMessage(nextStatus));
}
