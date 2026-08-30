import { existsSync, accessSync, constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { count, gt, lt, or } from "drizzle-orm";
import { createDb } from "../../db/client.js";
import { cardTable } from "../../db/schema.js";
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

/**
 * The range a card timestamp can hold and still name a moment this app could have written.
 *
 * The low end is one second past the epoch. Migration 0011 had to give `created_at` and
 * `updated_at` a literal `DEFAULT 0` in order to add them NOT NULL to a table with rows in
 * it, and SQLite cannot drop a column default afterwards — so an `INSERT INTO card` that
 * names neither column succeeds and lands the row at the epoch rather than failing.
 *
 * The high end is the largest instant a `Date` can represent. Past it, or below the matching
 * negative, drizzle hands the column back as an Invalid Date: a card that
 * `kozane card list --sort` can order — last, deliberately — but can print no time for.
 *
 * Nothing in the app writes a card outside this range. Inserts go through the `$defaultFn`
 * on `cardTable` and `db import` names both columns, so what reaches here is hand-written
 * SQL against the workspace database.
 */
const EARLIEST_CARD_STAMP = new Date(1_000);
const LATEST_CARD_STAMP = new Date(8_640_000_000_000_000);

/** How many cards carry either column outside that range. */
async function badlyStampedCards(url: string): Promise<number> {
  const db = await createDb(url);
  const [row] = await db
    .select({ total: count() })
    .from(cardTable)
    .where(
      or(
        lt(cardTable.createdAt, EARLIEST_CARD_STAMP),
        gt(cardTable.createdAt, LATEST_CARD_STAMP),
        lt(cardTable.updatedAt, EARLIEST_CARD_STAMP),
        gt(cardTable.updatedAt, LATEST_CARD_STAMP),
      ),
    );
  return row?.total ?? 0;
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

  // 1. Workspace detected. Found by path alone: an unreadable config is a check below,
  // not a reason for the whole command to fail before it reports anything.
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

  // 4. api.json valid, when there is one at all. A workspace has no key until
  // `kozane api key generate` is run, so an absent file is not a problem and is not
  // reported as one. What this catches is the file that exists and cannot be read: every
  // HTTP request consults it, so a hand-edited one takes the whole server to 503 until it
  // is fixed, and `doctor` is where that should be visible without starting a server.
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

  // 6. DB migration status
  let migrationOk = false;
  if (dbOk) {
    let detail: string | undefined;
    try {
      const status = await getMigrationStatus(dbUrl(resolve(root)));
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

  // 7. Card timestamps that name a moment, rather than defaulted or hand-edited past what a
  // date can hold. Only once the migrations are current, because before 0011 has run there
  // are no columns to read — a workspace that needs migrating is already reported by the
  // check above, and asking this of it would report the same problem a second time in a more
  // confusing way.
  if (dbOk && migrationOk) {
    let stampOk = false;
    let detail: string | undefined;
    try {
      const stale = await badlyStampedCards(dbUrl(resolve(root)));
      stampOk = stale === 0;
      if (stale > 0)
        detail =
          `${plural(stale, "card")} stamped outside what this app writes, likely inserted ` +
          "by hand; kozane card list --sort reports them as 1970 or invalid";
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("Card timestamps valid", stampOk, detail));
  }

  // 8. Port available
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The `config.json valid` check of {@link doctor} in full: every problem with the config
 * at once, rather than the single pass/fail line.
 */
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

  // Unknown keys are usually a typo worth showing, but not a reason to fail a scripted
  // run — `--strict` is there for setups that want them treated as errors.
  if (errors > 0 || (opts.strict && warnings > 0)) process.exit(1);
}
