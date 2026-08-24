import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { eq } from "drizzle-orm";
import { runWorkspaceCommand } from "../lib/workspace-command.js";
import type { WorkspaceConfig } from "../lib/config.js";
import type { DB } from "../../db/tx.js";
import {
  scanTaskspaces,
  diffTaskspaces,
  resolveTaskspacePath,
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
} from "../lib/taskspace-scan.js";
import { taskspaceTable, scopeTable } from "../../db/schema.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { resolveProjectId } from "../lib/project-selection.js";
import {
  addTaskspace,
  deleteTaskspace,
  getAllTaskspaces,
  getTaskspacesInProject,
} from "../../db/api/taskspace.js";
import { getAllProjects } from "../../db/api/project.js";
import { getAllScopes } from "../../db/api/scope.js";

// ─── taskspace scan ────────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

type ScanOptions = { apply?: boolean; reattach?: boolean; cleanup?: boolean };

export async function taskspaceScan(options: ScanOptions = {}): Promise<void> {
  if (options.reattach && !options.apply) {
    console.error("Error: --reattach requires --apply");
    process.exit(1);
  }
  if (options.cleanup && !options.apply) {
    console.error("Error: --cleanup requires --apply");
    process.exit(1);
  }

  await runWorkspaceCommand(async ({ db, root, config }) => {
    await scanWithin(db, root, config, options);
  });
}

async function scanWithin(
  db: DB,
  root: string,
  config: WorkspaceConfig,
  options: ScanOptions,
): Promise<void> {
  const searchRoots = config.taskspace.searchRoots.map((r) => (isAbsolute(r) ? r : join(root, r)));

  const found = scanTaskspaces(searchRoots);
  const dbRecords = await db.select().from(taskspaceTable);
  const taskspaceIds = [
    ...new Set([...dbRecords.map(({ id }) => id), ...found.map(({ taskspaceId }) => taskspaceId)]),
  ];
  const diff = diffTaskspaces(found, dbRecords, root);

  let updated = 0;
  let deleted = 0;

  const movedIds = new Set(diff.moved.map(({ record }) => record.id));
  const orphanIds = new Set(diff.orphans.map((taskspace) => taskspace.taskspaceId));
  const recordById = new Map(dbRecords.map((r) => [r.id, r]));
  const now = Date.now();
  for (const taskspace of found) {
    if (movedIds.has(taskspace.taskspaceId) || orphanIds.has(taskspace.taskspaceId)) continue;
    const record = recordById.get(taskspace.taskspaceId);
    const seenSuffix = record?.lastSeenAt
      ? `  (last seen ${formatAge(now - record.lastSeenAt.getTime())} ago)`
      : "  (never seen)";
    console.log(
      `  ok      ${shortId(taskspace.taskspaceId, taskspaceIds)}  ${taskspace.path}${seenSuffix}`,
    );
    if (options.apply) {
      await db
        .update(taskspaceTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(taskspaceTable.id, taskspace.taskspaceId));
    }
  }

  for (const { record, scanned } of diff.moved) {
    console.log(`  moved   ${shortId(record.id, taskspaceIds)}`);
    const oldAbsolute = record.path
      ? resolveTaskspacePath(record.path, record.pathKind, root)
      : "(none)";
    console.log(`    old: ${oldAbsolute}`);
    console.log(`    new: ${scanned.path}`);
    if (options.apply) {
      const pathKind = scanned.path.startsWith(root)
        ? ("project_relative" as const)
        : ("absolute" as const);
      const storedPath =
        pathKind === "project_relative" ? relative(root, scanned.path) : scanned.path;
      await db
        .update(taskspaceTable)
        .set({ path: storedPath, pathKind, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(taskspaceTable.id, record.id));
      updated++;
    }
  }

  for (const taskspace of diff.orphans) {
    console.log(`  orphan  ${shortId(taskspace.taskspaceId, taskspaceIds)}  ${taskspace.path}`);
    if (options.apply && options.reattach) {
      const pathKind = taskspace.path.startsWith(root)
        ? ("project_relative" as const)
        : ("absolute" as const);
      const storedPath =
        pathKind === "project_relative" ? relative(root, taskspace.path) : taskspace.path;
      await db.insert(taskspaceTable).values({
        id: taskspace.taskspaceId,
        projectId: taskspace.projectId || undefined,
        name: basename(taskspace.path),
        path: storedPath,
        pathKind,
        lastSeenAt: new Date(),
      });
      console.log(`    → reattached`);
      updated++;
    }
  }

  for (const record of diff.missing) {
    const absolutePath = record.path
      ? resolveTaskspacePath(record.path, record.pathKind, root)
      : "(no path)";
    console.log(`  missing ${shortId(record.id, taskspaceIds)}  ${absolutePath}`);
    if (options.apply && options.cleanup) {
      await db.delete(taskspaceTable).where(eq(taskspaceTable.id, record.id));
      console.log(`    → deleted`);
      deleted++;
    }
  }

  if (!options.apply) {
    const hints: string[] = [];
    if (diff.moved.length > 0)
      hints.push(`  taskspace scan --apply             update ${diff.moved.length} moved path(s)`);
    if (diff.orphans.length > 0)
      hints.push(`  taskspace scan --apply --reattach  reattach ${diff.orphans.length} orphan(s)`);
    if (diff.missing.length > 0)
      hints.push(
        `  taskspace scan --apply --cleanup   delete ${diff.missing.length} missing record(s)`,
      );
    if (hints.length > 0) {
      console.log(`\nTo apply changes, run:`);
      hints.forEach((h) => console.log(h));
    } else {
      console.log(`\nScan complete. Nothing to apply.`);
    }
  } else {
    const parts = [`${updated} updated`];
    if (options.cleanup) parts.push(`${deleted} deleted`);
    console.log(`\nScan complete. ${parts.join(", ")}.`);
  }
}

// ─── taskspace create ──────────────────────────────────────────────────────────────

type CreateOptions = { scope?: string | false; project?: string; dir?: string };

export async function taskspaceCreate(name: string, options: CreateOptions = {}): Promise<void> {
  if (options.scope === undefined) {
    console.error("Error: --scope <scopeId> is required. Use --no-scope to create without one.");
    process.exit(1);
  }
  await runWorkspaceCommand(async ({ db, root, config }) => {
    // Resolved plainly now: the wrapper turns a throw from either of these into the same
    // `Error: …` line the two hand-written catch blocks here used to print.
    const scopeId =
      typeof options.scope === "string"
        ? resolveShortId(
            options.scope,
            (await db.select({ id: scopeTable.id }).from(scopeTable)).map(({ id }) => id),
            "Scope",
          )
        : undefined;

    const targetDir = options.dir
      ? resolve(options.dir)
      : resolve(root, config.taskspace.defaultDir, name);

    if (existsSync(targetDir)) {
      const existingMarker = join(targetDir, TASKSPACE_MARKER_FILE);
      if (existsSync(existingMarker)) {
        console.error(`Directory already contains a Kozane taskspace: ${targetDir}`);
        process.exit(1);
      }
    }

    const pathKind = targetDir.startsWith(root)
      ? ("project_relative" as const)
      : ("absolute" as const);
    const storedPath = pathKind === "project_relative" ? relative(root, targetDir) : targetDir;

    const projectId = await resolveProjectId(db, options.project);

    const id = await addTaskspace({
      db,
      projectId,
      scopeId,
      name,
      path: storedPath,
      pathKind,
      lastSeenAt: new Date(),
    });

    const dirCreated = !existsSync(targetDir);
    try {
      mkdirSync(targetDir, { recursive: true });
      const marker = {
        kind: TASKSPACE_MARKER_KIND,
        version: TASKSPACE_MARKER_VERSION,
        taskspaceId: id,
        projectId: projectId ?? "",
      };
      writeFileSync(join(targetDir, TASKSPACE_MARKER_FILE), JSON.stringify(marker, null, 2) + "\n");
    } catch (e) {
      // Kept as its own catch rather than left to the wrapper: the record and the
      // directory both have to be undone before anything is said, and the two-line message
      // names the step that failed as well as the reason.
      await deleteTaskspace({ db, taskspaceId: id });
      if (dirCreated && existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      console.error("Failed to initialize taskspace directory.");
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }

    console.log(`Taskspace created.`);
    const taskspaceIds = (await db.select({ id: taskspaceTable.id }).from(taskspaceTable)).map(
      ({ id }) => id,
    );
    console.log(`  id   : ${shortId(id, taskspaceIds)}`);
    console.log(`  name : ${name}`);
    console.log(`  path : ${targetDir}`);
  });
}

// ─── taskspace list ────────────────────────────────────────────────────────────────

export type TaskspaceListOptions = { project?: string };

/**
 * Every taskspace in the workspace, with the project and scope each one sits under.
 *
 * Workspace-wide on purpose: a board draws only its own project's taskspaces and the
 * unassigned ones, so this is where a taskspace created from another project is visible at
 * all. `--project` narrows it to exactly what that project's board would show, unassigned
 * rows included.
 */
export async function taskspaceList(options: TaskspaceListOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    // Short IDs are drawn against every taskspace in the workspace, so the ID printed for a
    // row is the same one whether or not --project narrowed the list.
    const all = await getAllTaskspaces({ db });
    const taskspaceIds = all.map(({ id }) => id);

    const projectId = options.project ? await resolveProjectId(db, options.project) : null;
    const taskspaces = projectId ? await getTaskspacesInProject({ db, projectId }) : all;
    if (taskspaces.length === 0) {
      console.log(projectId ? "No taskspaces found in this project." : "No taskspaces found.");
      return;
    }

    const projectNameById = new Map(
      (await getAllProjects({ db })).map((project) => [project.id, project.name]),
    );
    const scopeNameById = new Map(
      (await getAllScopes({ db })).map((scope) => [scope.id, scope.name]),
    );

    for (const taskspace of taskspaces) {
      // An em dash in either column is a real state, not missing data: a taskspace with no
      // project shows on every board, and one with no scope gathers no cards.
      const project = taskspace.projectId
        ? (projectNameById.get(taskspace.projectId) ?? taskspace.projectId)
        : "—";
      const scope = taskspace.scopeId
        ? (scopeNameById.get(taskspace.scopeId) ?? taskspace.scopeId)
        : "—";
      const path = taskspace.path
        ? resolveTaskspacePath(taskspace.path, taskspace.pathKind, root)
        : "(no path)";
      console.log(
        `${shortId(taskspace.id, taskspaceIds)}  ${taskspace.name || "(unnamed)"}  ${project}  ${scope}  ${path}`,
      );
    }
  });
}
