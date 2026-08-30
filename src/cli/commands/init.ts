import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KOZANE_DIR, defaultConfig, writeConfig, dbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import { createProject } from "../../db/api/project.js";

/**
 * Keeps `.kozane/` out of a repository the workspace happens to sit in.
 *
 * A workspace is very often initialized inside a checkout, and the directory holds three
 * things that have no business being committed: the API key (`api-key`), which is a
 * credential; the runtime state, which is one machine's process id and port; and
 * `tag-index.json`, which caches lines quoted out of every taskspace file that was scanned —
 * and a taskspace created with `--dir` may point anywhere on the machine, so those lines can
 * come from outside the repository entirely. `docs/security-matrix.md` said to keep the
 * directory out of source control and left the doing of it to the reader; this does it.
 *
 * Inside `.kozane/` rather than appended to the repository's own `.gitignore`, which is a
 * file `kozane init` has no business editing: it may not exist, may be someone else's, and
 * would leave a line behind after the workspace was deleted. A `.gitignore` at the root of a
 * directory ignoring everything under itself is self-contained and goes when it goes.
 *
 * Best-effort. A workspace on a read-only filesystem, or one where this cannot be written for
 * any other reason, is still a working workspace — this is a courtesy about a neighbouring
 * tool, not a part of initializing anything.
 */
function writeIgnoreFile(kozaneDir: string): void {
  try {
    writeFileSync(
      join(kozaneDir, ".gitignore"),
      // Everything, itself included. Nothing in here is worth committing: the database is a
      // binary that merges badly, and the rest is a credential, one machine's state, and a
      // cache. A workspace meant to be shared is shared with `kozane db export`.
      "# Kozane's workspace directory. Holds a credential, this machine's state, and caches.\n*\n",
    );
  } catch {
    // See above.
  }
}

export async function init(): Promise<void> {
  const projectRoot = process.cwd();
  const kozaneDir = join(projectRoot, KOZANE_DIR);

  if (existsSync(kozaneDir)) {
    console.error(`Kozane workspace already exists at ${kozaneDir}`);
    process.exit(1);
  }

  const workspaceName = basename(resolve(projectRoot));

  mkdirSync(kozaneDir, { recursive: true });
  writeIgnoreFile(kozaneDir);

  const config = defaultConfig(workspaceName);
  writeConfig(projectRoot, config);

  console.log(`Initializing Kozane workspace "${workspaceName}"...`);

  await runMigrations(dbUrl(projectRoot));
  const db = await createDb(dbUrl(projectRoot));
  await createProject({ db, name: "main", isDefault: true });

  console.log(`
Kozane initialized.

  Workspace: ${workspaceName}
  Config   : ${KOZANE_DIR}/config.json
  Database : ${KOZANE_DIR}/kozane.db

Default project: main
`);
}
