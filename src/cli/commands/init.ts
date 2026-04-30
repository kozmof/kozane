import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KOZANE_DIR, defaultConfig, writeConfig, dbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";

export async function init(): Promise<void> {
  const projectRoot = process.cwd();
  const kozaneDir = join(projectRoot, KOZANE_DIR);

  if (existsSync(kozaneDir)) {
    console.error(`Kozane project already exists at ${kozaneDir}`);
    process.exit(1);
  }

  const projectName = basename(resolve(projectRoot));

  mkdirSync(kozaneDir, { recursive: true });
  mkdirSync(join(kozaneDir, "working-copies"), { recursive: true });

  const config = defaultConfig(projectName);
  writeConfig(projectRoot, config);

  console.log(`Initializing Kozane project "${projectName}"...`);

  await runMigrations(dbUrl(projectRoot));

  console.log(`
Kozane initialized.

  Project : ${projectName}
  Config  : ${KOZANE_DIR}/config.json
  Database: ${KOZANE_DIR}/kozane.db

Run "kozane dev" to start the local UI.
`);
}
