import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { requireWorkspace } from "../lib/project.js";
import { dbPath, dbUrl } from "../lib/config.js";
import { backupDb, getMigrationStatus, runMigrations, type MigrationStatus } from "../lib/db.js";
import { exportDbJson, hasDbJsonRows, importDbJson, stringifyDbJson } from "../lib/db-json.js";

type DbExportOptions = {
  pretty?: boolean;
};

type DbImportOptions = {
  force?: boolean;
};

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

function requireCurrentStatus(status: MigrationStatus): void {
  if (status.state === "current") return;

  console.error("Database must be current before JSON export/import.");
  console.error(migrationStatusMessage(status));
  if (status.state === "pending") console.error("\nRun: kozane db migrate");
  process.exit(1);
}

export async function dbExport(file?: string, options: DbExportOptions = {}): Promise<void> {
  const { root } = requireWorkspace();
  const projectRoot = resolve(root);
  const url = dbUrl(projectRoot);
  const status = await getMigrationStatus(url);
  requireCurrentStatus(status);

  const dump = await exportDbJson(url, {
    applied: status.applied?.tag ?? null,
    latest: status.latest?.tag ?? null,
  });
  const json = stringifyDbJson(dump, options.pretty ?? true);

  if (file) {
    const target = resolve(file);
    writeFileSync(target, json, "utf-8");
    console.log(`Database exported: ${target}`);
    return;
  }

  process.stdout.write(json);
}

export async function dbImport(file: string, options: DbImportOptions = {}): Promise<void> {
  const { root } = requireWorkspace();
  const projectRoot = resolve(root);
  const url = dbUrl(projectRoot);
  const status = await getMigrationStatus(url);
  requireCurrentStatus(status);

  let parsed: unknown;
  const source = resolve(file);
  try {
    parsed = JSON.parse(readFileSync(source, "utf-8"));
  } catch (e) {
    console.error(`Failed to read JSON import file: ${source}`);
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (!options.force && (await hasDbJsonRows(url))) {
    console.error("Database is not empty; refusing to import without --force.");
    console.error("Run: kozane db import <file> --force");
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

  try {
    const counts = await importDbJson(url, parsed);
    console.log(`Backup created: ${backupPath}`);
    console.log(`Database imported: ${source}`);
    for (const [table, count] of Object.entries(counts)) {
      console.log(`${table}: ${count}`);
    }
  } catch (e) {
    console.error("Import failed.");
    console.error(e instanceof Error ? e.message : String(e));
    console.error(`Backup remains at: ${backupPath}`);
    process.exit(1);
  }
}
