import { existsSync, accessSync, constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { createClient } from "@libsql/client";
import { count, gt, lt, or, sql, type SQL } from "drizzle-orm";
import { openDb } from "../../db/client.js";
import { BUSY_TIMEOUT_MS } from "../../db/pragmas.js";
import {
  cardTable,
  layerTable,
  namespaceTable,
  partitionTable,
  scopeTable,
  taskspaceTable,
} from "../../db/schema.js";
import { NAME_MAX } from "../../lib/constants.js";
import { canvasBoundsForRoot } from "../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../lib/server/content-limit.js";
import { CARD_STAMP_EARLIEST, CARD_STAMP_LATEST } from "../lib/card-sort.js";
import { plural } from "../lib/plural.js";
import { shortIdMap } from "../lib/short-id.js";
import { findWorkspaceRoot } from "../../db/internal/config.js";
import {
  KOZANE_DIR,
  CONFIG_FILE,
  DB_FILE,
  type WorkspaceConfig,
  defaultConfig,
  readConfig,
  dbUrl,
} from "../lib/config.js";
import { apiKeyPath, readApiKeyResult } from "../../lib/server/api-key.js";
import { getMigrationStatus } from "../lib/db.js";
import { diagnoseConfig } from "../lib/config-diagnostics.js";

type Check = { label: string; ok: boolean; detail?: string };

/** Maximum number of invalid cards to name alongside the total count. */
const NAMED_BAD_STAMPS = 5;

/** Total number of cards with invalid timestamps and a sample of their short IDs. */
type BadStamps = { total: number; named: string[] };

/**
 * Find cards with timestamps outside {@link CARD_STAMP_EARLIEST} and {@link
 * CARD_STAMP_LATEST}. Share these bounds with the card listing so diagnostics use the same
 * range.
 *
 * Count all matching cards, then fetch at most {@link NAMED_BAD_STAMPS} IDs to keep the
 * report bounded.
 */
async function badlyStampedCards(url: string): Promise<BadStamps> {
  const { db, close } = await openDb(url);
  try {
    const outsideRange = or(
      lt(cardTable.createdAt, CARD_STAMP_EARLIEST),
      gt(cardTable.createdAt, CARD_STAMP_LATEST),
      lt(cardTable.updatedAt, CARD_STAMP_EARLIEST),
      gt(cardTable.updatedAt, CARD_STAMP_LATEST),
    );
    const [counted] = await db.select({ total: count() }).from(cardTable).where(outsideRange);
    const total = counted?.total ?? 0;
    if (total === 0) return { total, named: [] };

    const worst = await db
      .select({ id: cardTable.id })
      .from(cardTable)
      .where(outsideRange)
      .limit(NAMED_BAD_STAMPS);
    // Read all IDs only when diagnostics need to name cards. `shortIdMap` requires the
    // complete set for unambiguous prefixes.
    const all = await db.select({ id: cardTable.id }).from(cardTable);
    const shortIds = shortIdMap(all.map(({ id }) => id));
    return { total, named: worst.map(({ id }) => shortIds.get(id) ?? id) };
  } finally {
    close();
  }
}

/**
 * Format a sample of IDs and the remaining count, such as `6fd3a2b, 41c0e9d and 3 more`.
 *
 * Accept the shared shape of {@link BadStamps} and {@link OverLimit}.
 */
function nameSome({ total, named }: { total: number; named: string[] }): string {
  const rest = total - named.length;
  return rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

/**
 * Check database structure and foreign-key references through a temporary read-only
 * connection.
 *
 * `integrity_check` reports damaged pages and inconsistent indexes. `foreign_key_check`
 * reports dangling references, including rows written by a connection with foreign-key
 * enforcement disabled. A structurally valid database can still contain those rows.
 *
 * Run these checks only on request. The integrity check scans the database and does not
 * belong in a request handler.
 */
async function databaseIntegrity(url: string): Promise<{ ok: boolean; detail?: string }> {
  const client = createClient({ url });
  try {
    await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // A valid database returns one row containing "ok". Check its value because a damaged
    // database can also return a single row.
    const integrity = await client.execute("PRAGMA integrity_check");
    const problems = integrity.rows
      .map((row) => String(Object.values(row)[0] ?? ""))
      .filter((text) => text !== "ok");
    if (problems.length > 0)
      return {
        ok: false,
        detail: `${plural(problems.length, "problem")} reported by SQLite: ${problems
          .slice(0, NAMED_BAD_STAMPS)
          .join("; ")}; restore from a backup with kozane db restore`,
      };

    // Zero rows when sound. Each row names a child table and the parent it failed to find.
    const orphans = await client.execute("PRAGMA foreign_key_check");
    if (orphans.rows.length > 0) {
      const tables = [...new Set(orphans.rows.map((row) => String(Object.values(row)[0] ?? "?")))];
      return {
        ok: false,
        detail:
          `${plural(orphans.rows.length, "row")} referencing a row that does not exist, in ` +
          `${tables.join(", ")}; written by a client that had PRAGMA foreign_keys off. ` +
          "Export what is readable with kozane db export, then kozane db restore",
      };
    }

    return { ok: true };
  } finally {
    client.close();
  }
}

/** How many rows of one kind sit past a limit, and the first few of them by name. */
type OverLimit = { total: number; named: string[] };

const noneOverLimit: OverLimit = { total: 0, named: [] };

/**
 * Report stored rows that exceed the workspace's current text, name, or canvas limits.
 *
 * HTTP and CLI writes enforce these limits. Imports warn instead of rejecting rows so backups
 * from workspaces with different settings remain restorable. The schema does not enforce
 * these configurable limits.
 *
 * Cards over the text limit remain readable and movable, but their text must be shortened
 * before an edit can be saved.
 *
 * SQLite's `length()` counts characters, while JavaScript writers count UTF-16 code units.
 * This check can undercount text containing astral characters and miss cards that writers
 * would reject.
 */
async function rowsOverLimits(
  url: string,
  limits: { contentMax: number; canvasWidth: number; canvasHeight: number },
): Promise<{ long: OverLimit; offBoard: OverLimit; names: OverLimit }> {
  const { db, close } = await openDb(url);
  try {
    const longContent = gt(sql`length(${cardTable.content})`, limits.contentMax);
    const offCanvas = or(
      lt(cardTable.posX, 0),
      lt(cardTable.posY, 0),
      gt(cardTable.posX, limits.canvasWidth),
      gt(cardTable.posY, limits.canvasHeight),
    );

    /**
     * Build short IDs at most once, and only if a condition needs to name cards. `shortIdMap`
     * needs every card ID to choose unambiguous prefixes.
     */
    let shortIds: Map<string, string> | null = null;
    const shortIdOf = async (id: string): Promise<string> => {
      shortIds ??= shortIdMap(
        (await db.select({ id: cardTable.id }).from(cardTable)).map((row) => row.id),
      );
      return shortIds.get(id) ?? id;
    };

    // `or()` returns `SQL | undefined` because it also accepts an empty set of conditions.
    // These arguments always provide conditions.
    const cardsMatching = async (where: SQL | undefined): Promise<OverLimit> => {
      const [counted] = await db.select({ total: count() }).from(cardTable).where(where);
      const total = counted?.total ?? 0;
      if (total === 0) return noneOverLimit;
      const worst = await db
        .select({ id: cardTable.id })
        .from(cardTable)
        .where(where)
        .limit(NAMED_BAD_STAMPS);
      // Short ids, because that is what `kozane card show` and `card edit` take.
      const named: string[] = [];
      for (const { id } of worst) named.push(await shortIdOf(id));
      return { total, named };
    };

    const long = await cardsMatching(longContent);
    const offBoard = await cardsMatching(offCanvas);

    // Count all named entities against the shared limit. Identify each match by table and
    // full ID, since its name is too long to print and short IDs would require separate maps
    // for each table.
    const named: string[] = [];
    let total = 0;
    for (const [label, table] of [
      ["namespace", namespaceTable],
      ["partition", partitionTable],
      ["layer", layerTable],
      ["scope", scopeTable],
      ["taskspace", taskspaceTable],
    ] as const) {
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(gt(sql`length(${table.name})`, NAME_MAX));
      total += rows.length;
      for (const { id } of rows) if (named.length < NAMED_BAD_STAMPS) named.push(`${label} ${id}`);
    }

    return { long, offBoard, names: { total, named } };
  } finally {
    close();
  }
}

function check(label: string, ok: boolean, detail?: string): Check {
  return { label, ok, detail };
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ host, port }, () => {
      conn.destroy();
      resolve(false); // port in use
    });
    conn.on("error", () => resolve(true)); // port free
    conn.setTimeout(500, () => {
      conn.destroy();
      resolve(true);
    });
  });
}

export async function doctor(): Promise<void> {
  const cwd = process.cwd();
  const checks: Check[] = [];

  // 1. Locate the workspace by path. Report unreadable configuration in its separate check.
  const root = findWorkspaceRoot(cwd);
  checks.push(check("Kozane workspace found", !!root, root ?? "run kozane init"));

  if (!root) {
    printChecks(checks);
    process.exit(1);
    return; // satisfies TS control-flow narrowing
  }

  // 2. .kozane/ directory
  const kozaneDir = join(root, KOZANE_DIR);
  checks.push(check(".kozane/ directory exists", existsSync(kozaneDir)));

  // 3. config.json readable
  const configPath = join(root, KOZANE_DIR, CONFIG_FILE);
  let config: WorkspaceConfig = defaultConfig(basename(root));
  let configOk = existsSync(configPath);
  if (configOk) {
    try {
      config = readConfig(root);
    } catch {
      configOk = false;
    }
  }
  checks.push(
    check("config.json valid", configOk, configOk ? undefined : "run kozane doctor config"),
  );

  // 4. Validate `api.json` when present. Absence is valid for a keyless workspace, but an
  // unreadable file prevents serving requests.
  const apiKeyFile = apiKeyPath(root);
  if (existsSync(apiKeyFile)) {
    const apiKeyResult = readApiKeyResult(root);
    checks.push(
      check(
        "api.json valid",
        apiKeyResult.ok,
        apiKeyResult.ok ? undefined : `${apiKeyResult.message}; run kozane api key refresh`,
      ),
    );
  }

  // 5. kozane.db readable/writable
  const dbFile = join(root, KOZANE_DIR, DB_FILE);
  let dbOk = existsSync(dbFile);
  if (dbOk) {
    try {
      accessSync(dbFile, constants.R_OK | constants.W_OK);
    } catch {
      dbOk = false;
    }
  }
  checks.push(
    check("kozane.db readable/writable", dbOk, dbOk ? undefined : "file missing or inaccessible"),
  );

  // Check the workspace's on-disk database even when `kozane open --memory` serves a
  // temporary database.
  const workspaceDbUrl = dbUrl(resolve(root));

  // 6. DB migration status
  let migrationOk = false;
  if (dbOk) {
    let detail: string | undefined;
    try {
      const status = await getMigrationStatus(workspaceDbUrl);
      migrationOk = status.state === "current";
      if (status.state === "pending") {
        detail = `${status.pendingCount} pending; run kozane db migrate`;
      } else if (status.state === "gapped") {
        detail = `skipped ${status.skipped.map((entry) => entry.tag).join(", ")}; run kozane db restore`;
      } else if (status.state === "unknown") {
        detail = status.error;
      } else if (status.state === "missing") {
        detail = "file missing";
      }
    } catch (e) {
      migrationOk = false;
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("DB migrations current", migrationOk, detail));
  }

  // Check timestamps only after migrations are current. Older schemas may lack the columns,
  // and the migration check already reports that problem.
  if (dbOk && migrationOk) {
    let stampOk = false;
    let detail: string | undefined;
    try {
      const stale = await badlyStampedCards(workspaceDbUrl);
      stampOk = stale.total === 0;
      if (stale.total > 0)
        detail =
          `${plural(stale.total, "card")} stamped outside what this app writes, likely ` +
          `inserted by hand: ${nameSome(stale)}; kozane card list --sort reports them as ` +
          "1970 or invalid";
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("Card timestamps valid", stampOk, detail));
  }

  // 8. Check SQLite integrity and references after migration validation so stale-schema
  // problems are reported once.
  if (dbOk && migrationOk) {
    let integrityOk = false;
    let detail: string | undefined;
    try {
      const integrity = await databaseIntegrity(workspaceDbUrl);
      integrityOk = integrity.ok;
      detail = integrity.detail;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("Database integrity", integrityOk, detail));
  }

  // 9. Report rows exceeding current write limits without modifying them. See
  // `rowsOverLimits`.
  if (dbOk && migrationOk) {
    let withinLimits = false;
    let detail: string | undefined;
    try {
      const workspaceRoot = resolve(root);
      const { long, offBoard, names } = await rowsOverLimits(workspaceDbUrl, {
        contentMax: contentMaxForRoot(workspaceRoot),
        ...canvasBoundsForRoot(workspaceRoot),
      });
      withinLimits = long.total === 0 && offBoard.total === 0 && names.total === 0;
      const parts: string[] = [];
      if (long.total > 0)
        parts.push(`${plural(long.total, "card")} over ui.contentMax: ${nameSome(long)}`);
      if (offBoard.total > 0)
        parts.push(`${plural(offBoard.total, "card")} off the canvas: ${nameSome(offBoard)}`);
      if (names.total > 0)
        parts.push(
          `${plural(names.total, "name")} over ${NAME_MAX} characters: ${nameSome(names)}`,
        );
      if (parts.length > 0) detail = `${parts.join("; ")}; editing one will refuse it`;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("Rows within workspace limits", withinLimits, detail));
  }

  // 10. Port available
  const host = config.server.host;
  const port = config.server.port;
  const portFree = await isPortAvailable(host, port);
  checks.push(check(`Port ${port} available`, portFree, portFree ? undefined : "already in use"));

  printChecks(checks);

  const allOk = checks.every((c) => c.ok);
  if (!allOk) process.exit(1);
}

function printChecks(checks: Check[]): void {
  for (const { label, ok, detail } of checks) {
    const icon = ok ? "✓" : "✗";
    const line = detail ? `${label} — ${detail}` : label;
    console.log(`  ${icon}  ${line}`);
  }
}

export type DoctorConfigOptions = {
  /** Fail on unknown keys too, not only on errors. */
  strict?: boolean;
};

/** Report every configuration problem found by {@link doctor}'s `config.json valid` check. */
export function doctorConfig(opts: DoctorConfigOptions = {}): void {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    console.error('No Kozane workspace found. Run "kozane init" first.');
    process.exit(1);
  }

  const { path, issues, notes } = diagnoseConfig(root);
  console.log(`Config: ${path}`);
  console.log("");

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;

  if (issues.length === 0) console.log("  ✓  No problems found");
  for (const { severity, message, found } of issues) {
    const icon = severity === "error" ? "✗" : "⚠";
    const detail = found === undefined ? "" : ` (found: ${JSON.stringify(found) ?? String(found)})`;
    console.log(`  ${icon}  ${message}${detail}`);
  }
  for (const { message, details } of notes) {
    console.log(`  ℹ  ${message}`);
    for (const detail of details) console.log(`       ${detail}`);
  }

  if (issues.length > 0) {
    console.log("");
    console.log(`${plural(errors, "error")}, ${plural(warnings, "warning")}`);
  }

  // Report unknown keys as warnings unless `--strict` requests a failing exit status.
  if (errors > 0 || (opts.strict && warnings > 0)) process.exit(1);
}
