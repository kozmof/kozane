/** `kozane doctor`: run every check and report the results. */
import { existsSync, accessSync, constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { NAME_MAX } from "../../../lib/constants.js";
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

  // 12. Port available
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
