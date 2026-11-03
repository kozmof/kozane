/** `kozane doctor`: run every check and report the results. */
import { existsSync, accessSync, constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DEFAULT_TASKSPACE_DIR, NAME_MAX } from "../../../lib/constants.js";
import { openDb } from "../../../db/client.js";
import { getAllNamespaces } from "../../../db/api/namespace.js";
import type { DB } from "../../../db/tx.js";
import { idMatches } from "../../../lib/short-id-key.js";
import { activeServerProcess } from "../../../lib/server/runtime-state.js";
import {
  type LayoutResult,
  applyTaskspaceLayout,
  describeMoves,
  layoutIsOld,
  layoutNeedsFix,
  planTaskspaceLayout,
} from "../../lib/taskspace-layout.js";
import { canvasBoundsForRoot } from "../../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../../lib/server/content-limit.js";
import { plural } from "../../lib/plural.js";
import { findWorkspaceRoot } from "../../../db/internal/config.js";
import {
  KOZANE_DIR,
  CONFIG_FILE,
  DB_FILE,
  type WorkspaceConfig,
  defaultConfig,
  readConfig,
  dbUrl,
} from "../../lib/config.js";
import { apiKeyPath, readApiKeyResult } from "../../../lib/server/api-key.js";
import { getMigrationStatus } from "../../lib/db.js";
import {
  type Check,
  NAMED_BAD_STAMPS,
  badlyStampedCards,
  nameSome,
  databaseIntegrity,
  rowsOverLimits,
  inventoryConflicts,
  namespacesWithoutDefaults,
  check,
  isPortAvailable,
} from "./checks.js";

export type DoctorOptions = {
  /** Fix what can be fixed safely before checking. Today that is the taskspace layout. */
  fix?: boolean;
};

export async function doctor(options: DoctorOptions = {}): Promise<void> {
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

  // 10. Report stored cards that overlap or are glued, and cards with only one inventory
  // column set, without changing them. Spans come from text and layout constants, so an
  // upgrade or an imported dump can leave overlaps behind. Raw SQL can leave the others.
  if (dbOk && migrationOk) {
    let consistent = false;
    let detail: string | undefined;
    try {
      const { overlapping, glued, halfPlaced } = await inventoryConflicts(workspaceDbUrl);
      consistent = overlapping.total === 0 && glued.total === 0 && halfPlaced.total === 0;
      const parts: string[] = [];
      if (overlapping.total > 0)
        parts.push(
          `${plural(overlapping.total, "stored card")} overlapping another: ${nameSome(overlapping)}`,
        );
      if (glued.total > 0)
        parts.push(`${plural(glued.total, "stored card")} still glued: ${nameSome(glued)}`);
      if (halfPlaced.total > 0)
        parts.push(
          `${plural(halfPlaced.total, "card")} with only one of inventory_id and inventory_slot set: ${nameSome(halfPlaced)}`,
        );
      if (parts.length > 0) detail = `${parts.join("; ")}; run kozane inventory repair`;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("Inventories consistent", consistent, detail));
  }

  // 11. Report namespaces missing a default partition or layer. No command recreates them, so
  // point at a backup.
  if (dbOk && migrationOk) {
    let complete = false;
    let detail: string | undefined;
    try {
      const missing = await namespacesWithoutDefaults(workspaceDbUrl);
      complete = missing.partition.length === 0 && missing.layer.length === 0;
      const parts: string[] = [];
      for (const label of ["partition", "layer"] as const) {
        const ids = missing[label];
        if (ids.length > 0)
          parts.push(
            `${plural(ids.length, "namespace")} without a default ${label}: ${nameSome({
              total: ids.length,
              named: ids.slice(0, NAMED_BAD_STAMPS),
            })}`,
          );
      }
      if (parts.length > 0) detail = `${parts.join("; ")}; restore a backup with kozane db restore`;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("Namespace defaults present", complete, detail));
  }

  // 12. Report owned taskspace directories outside the current layout, and move them with
  // `--fix`. Only the old layout fails the check, and `kozane open` refuses to start until
  // it is moved. Then check that every `namespacePaths` key names exactly one namespace.
  if (dbOk && migrationOk && configOk) {
    checks.push(
      ...(await taskspaceLayoutChecks(root, workspaceDbUrl, config, options.fix === true)),
    );
  }

  // 13. Port available
  const host = config.server.host;
  const port = config.server.port;
  const portFree = await isPortAvailable(host, port);
  checks.push(check(`Port ${port} available`, portFree, portFree ? undefined : "already in use"));

  printChecks(checks);

  const allOk = checks.every((c) => c.ok);
  if (!allOk) process.exit(1);
}

async function taskspaceLayoutChecks(
  root: string,
  url: string,
  config: WorkspaceConfig,
  fix: boolean,
): Promise<Check[]> {
  const { db, close } = await openDb(url);
  try {
    const checks = [await taskspaceLayoutCheck(db, root, config, fix)];
    const keys = Object.keys(config.taskspace.namespacePaths);
    if (keys.length > 0) checks.push(namespacePathsCheck(keys, await getAllNamespaces({ db })));
    return checks;
  } finally {
    close();
  }
}

async function taskspaceLayoutCheck(
  db: DB,
  root: string,
  config: WorkspaceConfig,
  fix: boolean,
): Promise<Check> {
  const label = "Taskspace layout current";
  try {
    let plan = await planTaskspaceLayout(db, root, config);
    if (fix && layoutNeedsFix(plan)) {
      // A running server would keep serving the old paths and could race the moves.
      const server = activeServerProcess(root);
      if (server)
        return check(
          label,
          false,
          `stop Kozane (process ${server.pid}) before kozane doctor --fix`,
        );
      const result = await applyTaskspaceLayout(db, root, plan);
      printLayoutFix(result);
      plan = await planTaskspaceLayout(db, root, readConfig(root));
    }
    if (!layoutNeedsFix(plan)) return check(label, true);
    if (!layoutIsOld(plan))
      // Such as after a namespace was renamed. The directories keep working, so this passes.
      return check(
        label,
        true,
        `${directories(plan.moves.length)} not where new ones go; kozane doctor --fix moves them`,
      );
    const parts: string[] = [];
    if (plan.legacyDefaultDir) parts.push('config.json still has the old "defaultDir": "."');
    if (plan.moves.length > 0) parts.push(`${directories(plan.moves.length)} to move`);
    return check(label, false, `${parts.join("; ")}; run kozane doctor --fix`);
  } catch (e) {
    return check(label, false, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Every `taskspace.namespacePaths` key must name exactly one namespace. A key that names none,
 * such as a typo or a deleted namespace, would otherwise be ignored without a word, and one
 * that names several stops `taskspace create` for those namespaces.
 */
function namespacePathsCheck(keys: readonly string[], namespaces: readonly { id: string }[]) {
  const problems: string[] = [];
  for (const key of keys) {
    const count = namespaces.filter(({ id }) => idMatches(key, id)).length;
    if (count === 0) problems.push(`"${key}" matches no namespace`);
    else if (count > 1) problems.push(`"${key}" matches ${count} namespaces`);
  }
  return check(
    "taskspace.namespacePaths keys match namespaces",
    problems.length === 0,
    problems.length > 0 ? `${problems.join("; ")}; use IDs from kozane namespace list` : undefined,
  );
}

function printLayoutFix({ configUpdated, configKept, moved, failed }: LayoutResult): void {
  console.log("Taskspace layout:");
  if (configUpdated) console.log(`  set taskspace.defaultDir to "${DEFAULT_TASKSPACE_DIR}"`);
  if (configKept)
    console.log('  kept "defaultDir": "." until every directory has moved; run --fix again');
  if (moved.length > 0) {
    console.log(`  moved ${directories(moved.length)}:`);
    for (const line of describeMoves(moved, "    ")) console.log(line);
  }
  for (const { move, reason } of failed) console.log(`  ! could not move ${move.from}: ${reason}`);
  console.log("");
}

function printChecks(checks: Check[]): void {
  for (const { label, ok, detail } of checks) {
    const icon = ok ? "✓" : "✗";
    const line = detail ? `${label} — ${detail}` : label;
    console.log(`  ${icon}  ${line}`);
  }
}

/** `1 taskspace directory`, `2 taskspace directories`. */
function directories(count: number): string {
  return `${count} taskspace ${count === 1 ? "directory" : "directories"}`;
}
