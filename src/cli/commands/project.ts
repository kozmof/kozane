import { resolve } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { openDb, runMigrations } from "../lib/db.js";
import { addProject, deleteProject, getAllProjects } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";

export async function projectCreate(name: string): Promise<void> {
  const { root } = requireWorkspace();
  const url = dbUrl(resolve(root));
  await runMigrations(url);
  const db = await openDb(url);
  const projectId = await addProject({ db, name });
  await addBundle({ db, projectId, name: "General", isDefault: true });
  console.log(`Project created.`);
  console.log(`  id  : ${projectId}`);
  console.log(`  name: ${name}`);
}

export async function projectList(): Promise<void> {
  const { root } = requireWorkspace();
  const url = dbUrl(resolve(root));
  const db = await openDb(url);
  const projects = await getAllProjects({ db });
  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }
  for (const p of projects) {
    console.log(`${p.id}  ${p.name}`);
  }
}

export async function projectDelete(projectId: string): Promise<void> {
  const { root } = requireWorkspace();
  const url = dbUrl(resolve(root));
  const db = await openDb(url);
  await deleteProject({ db, projectId });
  console.log(`Project deleted.`);
  console.log(`  id: ${projectId}`);
}
