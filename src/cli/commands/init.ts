import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KOZANE_DIR, defaultConfig, writeConfig, dbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";

export async function init(): Promise<void> {
  const projectRoot = process.cwd();
  const kozaneDir = join(projectRoot, KOZANE_DIR);

  if (existsSync(kozaneDir)) {
    console.error(`Kozane workspace already exists at ${kozaneDir}`);
    process.exit(1);
  }

  const workspaceName = basename(resolve(projectRoot));

  mkdirSync(kozaneDir, { recursive: true });

  const config = defaultConfig(workspaceName);
  writeConfig(projectRoot, config);

  console.log(`Initializing Kozane workspace "${workspaceName}"...`);

  await runMigrations(dbUrl(projectRoot));

  console.log(`
Kozane initialized.

  Workspace: ${workspaceName}
  Config   : ${KOZANE_DIR}/config.json
  Database : ${KOZANE_DIR}/kozane.db

Next: run "kozane project create <name>" to create your first project.
`);
}
