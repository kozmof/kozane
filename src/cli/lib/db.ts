import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as schema from "../../db/schema.js";
import type { DB } from "../../db/tx.js";
import { dbPath } from "./config.js";

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
  | {
      state: "unknown";
      dbPath: string | null;
      latest: MigrationJournalEntry | null;
      applied: MigrationJournalEntry | null;
      pendingCount: number | null;
      error: string;
    };

export async function openDb(dbUrl: string): Promise<DB> {
  const client = createClient({ url: dbUrl });
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema }) as unknown as DB;
}

export function resolveMigrationsFolder(): string {
  // Migrations are bundled relative to this file at build time.
  // At runtime (tsx or compiled): resolve from package root.
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/lib -> src/cli -> src -> project root
  const packageRoot = resolve(here, "../../..");
  return join(packageRoot, "drizzle");
}

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

function pathFromDbUrl(dbUrl: string): string | null {
  if (!dbUrl.startsWith("file:")) return null;
  return fileURLToPath(dbUrl);
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
      applied: null,
      pendingCount: null,
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
    const table = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      args: ["__drizzle_migrations"],
    });
    const hasMigrationTable = table.rows.length > 0;
    const appliedCreatedAt = hasMigrationTable
      ? await client.execute(
          "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
        )
      : null;
    const rawCreatedAt = appliedCreatedAt?.rows[0]?.created_at;
    const createdAt =
      typeof rawCreatedAt === "number"
        ? rawCreatedAt
        : typeof rawCreatedAt === "string"
          ? Number(rawCreatedAt)
          : null;
    if (createdAt !== null && !Number.isFinite(createdAt)) {
      throw new Error("Invalid latest applied migration timestamp");
    }

    const applied = migrationByWhen(entries, createdAt);
    const pending = entries.filter((entry) => createdAt === null || entry.when > createdAt);
    if (pending.length === 0) {
      return { state: "current", dbPath: filePath, latest, applied, pendingCount: 0 };
    }

    if (!latest) {
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
      applied: null,
      pendingCount: null,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    client.close();
  }
}

function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function backupDb(projectRoot: string): string {
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

  copyFileSync(source, target);
  return target;
}

export async function runMigrations(dbUrl: string): Promise<void> {
  const client = createClient({ url: dbUrl });
  const db = drizzle(client, { schema });

  try {
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  } finally {
    client.close();
  }
}
