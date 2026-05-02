import { resolve } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { addProject } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";

export async function projectCreate(name: string): Promise<void> {
  const { root } = requireWorkspace();
  const db = openDb(dbUrl(resolve(root)));
  const projectId = await addProject({ db, name });
  await addBundle({ db, projectId, name: "General" });
  console.log(`Project created.`);
  console.log(`  id  : ${projectId}`);
  console.log(`  name: ${name}`);
}
