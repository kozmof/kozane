import {
  createProject,
  deleteProject,
  getAllProjects,
  setDefaultProject,
} from "../../db/api/project.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export async function projectCreate(name: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const projectId = await createProject({ db, name });
    const projectIds = (await getAllProjects({ db })).map((project) => project.id);
    console.log(`Project created.`);
    console.log(`  id  : ${shortId(projectId, projectIds)}`);
    console.log(`  name: ${name}`);
  });
}

export async function projectList(): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
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
  });
}

export async function projectDefault(projectId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const projects = await getAllProjects({ db });
    const projectIds = projects.map((project) => project.id);
    const resolvedId = resolveShortId(projectId, projectIds, "Project");
    await setDefaultProject({ db, projectId: resolvedId });
    console.log("Default project changed.");
    console.log(`  id  : ${shortId(resolvedId, projectIds)}`);
    console.log(`  name: ${projects.find((project) => project.id === resolvedId)?.name}`);
  });
}

export async function projectDelete(projectId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const projects = await getAllProjects({ db });
    const projectIds = projects.map((project) => project.id);
    const resolvedId = resolveShortId(projectId, projectIds, "Project");
    await deleteProject({ db, projectId: resolvedId });
    console.log(`Project deleted.`);
    console.log(`  id: ${shortId(resolvedId, projectIds)}`);
  });
}
