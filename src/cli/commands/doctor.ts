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

/**
 * How many of the offending cards the check names before it stops counting them out. A
 * workspace whose whole `card` table was inserted by hand has nothing to gain from a
 * thousand ids on one line, and the ones it does print are enough to find the rest with.
 */
const NAMED_BAD_STAMPS = 5;

/** How many cards are stamped wrongly, and the short ids of the first few of them. */
type BadStamps = { total: number; named: string[] };

/**
 * The cards carrying either timestamp outside {@link CARD_STAMP_EARLIEST}..{@link
 * CARD_STAMP_LATEST} — the range the listing reads them by, imported rather than restated
 * so this check and what `card list --sort` prints cannot come to disagree.
 *
 * Names rows as well as counting them: the count alone said a card was wrong and left
 * finding it to the reader. Counted and named by two statements rather than one, so a
 * workspace whose whole table was written by hand is still only {@link NAMED_BAD_STAMPS}
 * rows to carry back — and still an exact count.
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
    // Every id in the workspace, and only once there is something to name with them:
    // `shortIdMap` needs the whole set to know how short a prefix stays unambiguous, and a
    // sound workspace should not pay for a second pass over `card` to be told it is sound.
    const all = await db.select({ id: cardTable.id }).from(cardTable);
    const shortIds = shortIdMap(all.map(({ id }) => id));
    return { total, named: worst.map(({ id }) => shortIds.get(id) ?? id) };
  } finally {
    close();
  }
}

/**
 * `6fd3a2b, 41c0e9d and 3 more`, or as much of that as there is.
 *
 * Takes the shape rather than one of the named types, because {@link BadStamps} and
 * {@link OverLimit} are the same shape for the same reason — an exact count with a few rows
 * named out of it — and this formats either.
 */
function nameSome({ total, named }: { total: number; named: string[] }): string {
  const rest = total - named.length;
  return rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

/**
 * What SQLite itself says about the file, which nothing here was asking.
 *
 * Every other check reads the database *through* the schema — the migration state, the card
 * timestamps — and so can only report what a well-formed file says. A corrupted page or an
 * orphaned row is invisible to all of them: the queries that would meet it are the ones a
 * workspace runs in the course of being used, so the first report is a failed request or a
 * board missing cards, at which point the question is whether the file or Kozane is at fault.
 * `doctor` is where that question belongs.
 *
 * Both pragmas, because they answer different things. `integrity_check` is about the file —
 * page structure, index entries that do not match their table — and is the one that matters
 * after a disk filled up or a backup was copied out from under a running server.
 * `foreign_key_check` is about the rows, and can find something `integrity_check` calls
 * sound: `PRAGMA foreign_keys` is a per-connection setting, so a row written over a
 * connection that left it off is a dangling reference in a structurally perfect file.
 * `sqlite3` on the command line is the plain way in, since that is the state it starts in —
 * libsql's own client defaults it on, and `db/pragmas.ts` sets it regardless, which is what
 * keeps every connection Kozane opens off that path. This is what notices when something
 * else took it.
 *
 * A read-only connection opened for the length of the check. `integrity_check` walks the
 * whole file, so it is not something to leave on a hot path; it is cheap enough once, on a
 * command someone ran to ask.
 */
async function databaseIntegrity(url: string): Promise<{ ok: boolean; detail?: string }> {
  const client = createClient({ url });
  try {
    await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Answers with one row reading "ok" when sound, and otherwise a row per problem — so the
    // test is the content, not the row count.
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
 * The rows this workspace's own write paths would now refuse.
 *
 * Three ways in, and only two of them are guarded. The HTTP endpoints check `ui.contentMax`
 * and {@link NAME_MAX} and clamp to the canvas; the CLI's card commands do the same through
 * `contentMaxForRoot` and `clampToBounds`. `kozane db import` is the third, and it
 * deliberately does not refuse — a dump is a backup, and these limits are *settings*, so a
 * workspace exported with a wider canvas must still be restorable into one with the default
 * (see `dumpLimitWarnings`). It warns instead, and this is what makes the rows findable
 * afterwards rather than only at the moment of the import.
 *
 * Nothing in the schema enforces any of the three, which is the other half of why this is
 * worth a check: a `CHECK` constraint on `content` could not be changed afterwards without a
 * table rebuild, and `ui.contentMax` is a number the user is invited to change.
 *
 * Not a failure of the database, and reported as a check so that it is said out loud. A card
 * past the limit is readable and movable; what it is not is *editable* — the composer and
 * `kozane card edit` both refuse it until it is shortened — and that is a thing to be told
 * once rather than discovered while trying to work.
 *
 * Measured with SQLite's `length()`, which counts characters, where the writers measure
 * `String.prototype.length`, which counts UTF-16 code units. They agree on everything in the
 * BMP and disagree by one per astral character — an emoji is two units and one character — so
 * this under-reports a card made of emoji that the endpoints would refuse. The direction is
 * the safe one: nothing is named here that the write paths accept. Closing it would mean
 * counting surrogate pairs in SQL, for a check whose whole job is to point at rows worth
 * looking at.
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
     * Every card id in the workspace as a short id, read at most once however many of the
     * two conditions below have something to name.
     *
     * The pass is what `badlyStampedCards` pays for the same reason — `shortIdMap` needs the
     * whole set to know how short a prefix stays unambiguous — and the memoization is the
     * difference between the two: there is one condition there and two here, so computing it
     * per condition would scan `card` twice on a workspace that trips both, and a sound one
     * must not scan it at all to be told it is sound.
     */
    let shortIds: Map<string, string> | null = null;
    const shortIdOf = async (id: string): Promise<string> => {
      shortIds ??= shortIdMap(
        (await db.select({ id: cardTable.id }).from(cardTable)).map((row) => row.id),
      );
      return shortIds.get(id) ?? id;
    };

    // `SQL | undefined` is what `or()` returns — it has nothing to combine when every one of
    // its arguments is undefined, which these never are. The same widening `.where()` does.
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

    // Every named thing shares one limit, so they are counted together. Located by table and
    // full id: the name is the thing that is too long to print, and a short id would have to
    // be unambiguous within each of five tables rather than within one — a prefix scheme
    // these rows are too rare to be worth. A full id is what `kozane scope delete` takes.
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

  // The workspace's own database, which is what both of the checks below read — not
  // `commandDbUrl`, so that `doctor` run while `kozane open --memory` holds a temporary one
  // still reports on the file the workspace keeps.
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

  // 7. Card timestamps that name a moment, rather than defaulted or hand-edited past what a
  // date can hold. Only once the migrations are current, because before 0011 has run there
  // are no columns to read — a workspace that needs migrating is already reported by the
  // check above, and asking this of it would report the same problem a second time in a more
  // confusing way.
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

  // 8. What SQLite says about the file and its references. After the migration check for the
  // reason the timestamps are: a workspace that needs migrating has one thing to be told, and
  // `foreign_key_check` against a schema half a version behind would name tables as a
  // consequence of that rather than as a problem of their own.
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

  // 9. Rows past the limits every write path holds new rows to. Reported rather than fixed:
  // see `rowsOverLimits` for why `kozane db import` lets them in on purpose.
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
