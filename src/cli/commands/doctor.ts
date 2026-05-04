import { existsSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { detectWorkspace } from "../lib/project.js";
import { KOZANE_DIR, CONFIG_FILE, DB_FILE, readConfig, dbUrl } from "../lib/config.js";
import { getMigrationStatus, openDb } from "../lib/db.js";
import { workingCopyTable } from "../../db/schema.js";
import { resolveWorkingCopyPath } from "../lib/wc-scan.js";

type Check = { label: string; ok: boolean; detail?: string };

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

  // 1. Workspace detected
  const workspace = detectWorkspace(cwd);
  checks.push(check("Kozane workspace found", !!workspace, workspace?.root ?? "run kozane init"));

  if (!workspace) {
    printChecks(checks);
    process.exit(1);
    return; // satisfies TS control-flow narrowing
  }

  const { root } = workspace;

  // 2. .kozane/ directory
  const kozaneDir = join(root, KOZANE_DIR);
  checks.push(check(".kozane/ directory exists", existsSync(kozaneDir)));

  // 3. config.json readable
  const configPath = join(root, KOZANE_DIR, CONFIG_FILE);
  let config = workspace.config;
  let configOk = existsSync(configPath);
  if (configOk) {
    try {
      config = readConfig(root);
    } catch {
      configOk = false;
    }
  }
  checks.push(check("config.json valid", configOk));

  // 4. kozane.db readable/writable
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

  // 5. DB migration status
  if (dbOk) {
    let migrationOk = false;
    let detail: string | undefined;
    try {
      const status = await getMigrationStatus(dbUrl(resolve(root)));
      migrationOk = status.state === "current";
      if (status.state === "pending") {
        detail = `${status.pendingCount} pending; run kozane db migrate`;
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

  // 6. Working copies on disk
  if (dbOk) {
    try {
      const db = await openDb(dbUrl(resolve(root)));
      const wcs = await db.select().from(workingCopyTable);
      const missing = wcs.filter((wc) => {
        if (!wc.path) return false;
        const absPath = resolveWorkingCopyPath(wc.path, wc.pathKind, root);
        return !existsSync(absPath);
      });
      const ok = missing.length === 0;
      const detail = ok
        ? undefined
        : missing.map((wc) => `${wc.name || wc.id}`).join(", ");
      checks.push(check("Working copies on disk", ok, detail ? `missing: ${detail}` : undefined));
    } catch (e) {
      checks.push(check("Working copies on disk", false, e instanceof Error ? e.message : String(e)));
    }
  }

  // 7. Port available
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
