import {
  addScope,
  deleteScope,
  getAllScopes,
  getScopeProjectUsage,
  getScopesInProject,
} from "../../db/api/scope.js";
import { getAllProjects } from "../../db/api/project.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export async function scopeAdd(name: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Scope name cannot be empty.");
    const scopeId = await addScope({ db, name: trimmedName });
    const scopeIds = (await getAllScopes({ db })).map((scope) => scope.id);
    console.log("Scope added.");
    console.log(`  id  : ${shortId(scopeId, scopeIds)}`);
    console.log(`  name: ${trimmedName}`);
  });
}

export type ScopeListOptions = { project?: string };

/**
 * Every scope in the workspace and the projects each one reaches.
 *
 * Workspace-wide on purpose: a board draws only its own project's scopes, so this is where
 * a scope shared with — or stranded in — another project is visible at all. `--project`
 * narrows it to exactly what that project's board would show.
 */
export async function scopeList(options: ScopeListOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    // Short IDs are always drawn against every scope in the workspace, so the ID printed
    // for a scope is the same one whether or not --project narrowed the list.
    const allScopes = await getAllScopes({ db });
    const scopeIds = allScopes.map((scope) => scope.id);

    const projectId = options.project ? await resolveProjectId(db, options.project) : null;
    const scopes = projectId ? await getScopesInProject({ db, projectId }) : allScopes;
    if (scopes.length === 0) {
      console.log(projectId ? "No scopes found in this project." : "No scopes found.");
      return;
    }

    const projects = await getAllProjects({ db });
    const projectNameById = new Map(projects.map((project) => [project.id, project.name]));
    const usage = await getScopeProjectUsage({ db });
    const projectsByScope = new Map<string, string[]>();
    for (const { scopeId, projectId: usedBy } of usage) {
      const names = projectsByScope.get(scopeId) ?? [];
      names.push(projectNameById.get(usedBy) ?? usedBy);
      projectsByScope.set(scopeId, names);
    }

    for (const scope of scopes) {
      // "(unused)" rather than a blank column: a scope no project has reached yet is
      // visible from every board, and that is worth saying rather than leaving to be read
      // as missing data.
      const where = projectsByScope.get(scope.id)?.sort().join(", ") ?? "(unused)";
      console.log(`${shortId(scope.id, scopeIds)}  ${scope.name}  ${where}`);
    }
  });
}

export async function scopeDelete(scopeId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const scopes = await getAllScopes({ db });
    const scopeIds = scopes.map((scope) => scope.id);
    const resolvedId = resolveShortId(scopeId, scopeIds, "Scope");
    await deleteScope({ db, scopeId: resolvedId });
    console.log("Scope deleted.");
    console.log(`  id: ${shortId(resolvedId, scopeIds)}`);
    console.log("Taskspaces attached to this scope are now unscoped.");
  });
}
