import { resolve } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import {
  addProject,
  deleteProject,
  getAllProjects,
  setDefaultProject,
} from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";
import { resolveShortId, shortId } from "../lib/short-id.js";

export async function projectCreate(name: string): Promise<void> {
  const { root } = requireWorkspace();
  const url = dbUrl(resolve(root));
  await runMigrations(url);
  const db = await createDb(url);
  const projectId = await addProject({ db, name });
  await addBundle({ db, projectId, name: "General", isDefault: true });
  const projectIds = (await getAllProjects({ db })).map((project) => project.id);
  console.log(`Project created.`);
  console.log(`  id  : ${shortId(projectId, projectIds)}`);
  console.log(`  name: ${name}`);
}

export async function projectList(): Promise<void> {
  const { root } = requireWorkspace();
  const url = dbUrl(resolve(root));
  const db = await createDb(url);
  const projects = await getAllProjects({ db });
  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }
  const projectIds = projects.map((project) => project.id);
  for (const project of projects) {
    console.log(
      `${shortId(project.id, projectIds)}  ${project.name}${project.isDefault ? "  (default)" : ""}`,
    );
  }
}

export async function projectDefault(projectId: string): Promise<void> {
  const { root } = requireWorkspace();
  const db = await createDb(dbUrl(resolve(root)));
  try {
    const projects = await getAllProjects({ db });
    const resolvedId = resolveShortId(
      projectId,
      projects.map((project) => project.id),
      "Project",
    );
    await setDefaultProject({ db, projectId: resolvedId });
    console.log("Default project changed.");
    console.log(
      `  id  : ${shortId(
        resolvedId,
        projects.map((project) => project.id),
      )}`,
    );
    console.log(`  name: ${projects.find((project) => project.id === resolvedId)?.name}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export async function projectDelete(projectId: string): Promise<void> {
  const { root } = requireWorkspace();
  const url = dbUrl(resolve(root));
  const db = await createDb(url);
  try {
    const projects = await getAllProjects({ db });
    const resolvedId = resolveShortId(
      projectId,
      projects.map((project) => project.id),
      "Project",
    );
    await deleteProject({ db, projectId: resolvedId });
    console.log(`Project deleted.`);
    console.log(
      `  id: ${shortId(
        resolvedId,
        projects.map((project) => project.id),
      )}`,
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
