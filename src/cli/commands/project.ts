import { resolve } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { openDb, runMigrations } from "../lib/db.js";
import { addProject } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";

export async function projectCreate(name: string): Promise<void> {
  const { root } = requireWorkspace();
  const url = dbUrl(resolve(root));
  await runMigrations(url);
  const db = openDb(url);
  const projectId = await addProject({ db, name });
  await addBundle({ db, projectId, name: "General", isDefault: true });
  console.log(`Project created.`);
  console.log(`  id  : ${projectId}`);
  console.log(`  name: ${name}`);
}
