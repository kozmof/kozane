import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KOZANE_DIR, defaultConfig, writeConfig, dbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import { createNamespace } from "../../db/api/namespace.js";

/**
 * Write a `.gitignore` inside `.kozane/` to exclude workspace state from Git.
 *
 * The directory contains the API key, process state, and cached text from taskspace files.
 * Taskspaces can point outside the repository, so the cache can contain external content.
 *
 * Keep the ignore rule inside the workspace directory so it is removed with that directory
 * and does not require editing the repository's `.gitignore`.
 *
 * Failure to write this optional file does not prevent initialization.
 */
function writeIgnoreFile(kozaneDir: string): void {
  try {
    writeFileSync(
      join(kozaneDir, ".gitignore"),
      // Ignore everything in the workspace state directory, including this file. Share data
      // through `kozane db export`.
      "# Kozane's workspace directory. Holds a credential, this machine's state, and caches.\n*\n",
    );
  } catch {
    // See above.
  }
}

export async function init(): Promise<void> {
  const workspaceRoot = process.cwd();
  const kozaneDir = join(workspaceRoot, KOZANE_DIR);

  if (existsSync(kozaneDir)) {
    console.error(`Kozane workspace already exists at ${kozaneDir}`);
    process.exit(1);
  }

  const workspaceName = basename(resolve(workspaceRoot));

  mkdirSync(kozaneDir, { recursive: true });
  writeIgnoreFile(kozaneDir);

  const config = defaultConfig(workspaceName);
  writeConfig(workspaceRoot, config);

  console.log(`Initializing Kozane workspace "${workspaceName}"...`);

  await runMigrations(dbUrl(workspaceRoot));
  const db = await createDb(dbUrl(workspaceRoot));
  await createNamespace({ db, name: "main", isDefault: true });

  console.log(`
Kozane initialized.

  Workspace: ${workspaceName}
  Config   : ${KOZANE_DIR}/config.json
  Database : ${KOZANE_DIR}/kozane.db

Default namespace: main
`);
}
