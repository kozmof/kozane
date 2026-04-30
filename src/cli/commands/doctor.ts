import { existsSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { detectProject } from "../lib/project.js";
import { KOZANE_DIR, CONFIG_FILE, DB_FILE, readConfig, dbUrl } from "../lib/config.js";
import { openDb } from "../lib/db.js";

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

  // 1. Project detected
  const project = detectProject(cwd);
  checks.push(check("Kozane project found", !!project, project?.root ?? "run kozane init"));

  if (!project) {
    printChecks(checks);
    process.exit(1);
    return; // satisfies TS control-flow narrowing
  }

  const { root } = project;

  // 2. .kozane/ directory
  const kozaneDir = join(root, KOZANE_DIR);
  checks.push(check(".kozane/ directory exists", existsSync(kozaneDir)));

  // 3. config.json readable
  const configPath = join(root, KOZANE_DIR, CONFIG_FILE);
  let config = project.config;
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

  // 5. DB schema check (tables exist)
  if (dbOk) {
    let schemaOk = false;
    try {
      const db = openDb(dbUrl(resolve(root)));
      await db
        .select()
        .from((await import("../../db/schema.js")).projectTable)
        .limit(1);
      schemaOk = true;
    } catch {
      schemaOk = false;
    }
    checks.push(check("DB schema valid", schemaOk));
  }

  // 6. Port available
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
