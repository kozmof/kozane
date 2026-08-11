import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KOZANE_DIR, defaultConfig, writeConfig, dbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import { addProject } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";
import { addLayer } from "../../db/api/layer.js";
import { DEFAULT_LAYER_NAME } from "../../lib/constants.js";

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
  const db = await createDb(dbUrl(projectRoot));
  const projectId = await addProject({ db, name: "main", isDefault: true });
  await addBundle({ db, projectId, name: "General", isDefault: true });
  await addLayer({ db, projectId, name: DEFAULT_LAYER_NAME, isDefault: true });

  console.log(`
Kozane initialized.

  Workspace: ${workspaceName}
  Config   : ${KOZANE_DIR}/config.json
  Database : ${KOZANE_DIR}/kozane.db

Default project: main
`);
}
