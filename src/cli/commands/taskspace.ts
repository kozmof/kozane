import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "../../lib/server/atomic-write.js";
import { isPlainObject } from "../../lib/plain-object.js";
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";
import {
  enclosingRecordedTaskspace,
  enclosingTaskspaceDir,
  makeParentsInside,
  missingDirs,
  removeEmptyDirs,
} from "../../lib/server/taskspace-directory.js";
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
import { pickNamespaceId, resolveNamespaceId } from "../lib/namespace-selection.js";
import {
  addTaskspace,
  deleteTaskspace,
  getAllTaskspaces,
  getTaskspacesInNamespace,
} from "../../db/api/taskspace.js";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { taskspaceParentDir } from "../../lib/server/taskspace-location.js";
import { errorCode, isStrictlyInside } from "../../lib/server/fs-paths.js";
import { getAllScopes } from "../../db/api/scope.js";
import { taskspaceNameIssue } from "../../lib/constants.js";

// ─── taskspace scan ────────────────────────────────────────────────────────────────

/**
 * How to store a taskspace path: relative when it is strictly inside the workspace root, else
 * absolute. Whole segments are compared, so `/ws-other` is not taken to be inside `/ws`, and
 * the root itself is stored absolute rather than as an empty relative path.
 */
function storedLocation(root: string, path: string) {
  const base = resolve(root);
  return isStrictlyInside(base, path)
    ? { pathKind: "workspace_relative" as const, storedPath: relative(base, path) }
    : { pathKind: "absolute" as const, storedPath: path };
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

type ScanOptions = { apply?: boolean; reattach?: boolean; cleanup?: boolean; namespace?: string };

export async function taskspaceScan(options: ScanOptions = {}): Promise<void> {
  if (options.reattach && !options.apply) {
    console.error("Error: --reattach requires --apply");
    process.exit(1);
  }
  if (options.namespace && !options.reattach) {
    console.error("Error: --namespace requires --reattach");
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
  // Resolve `--namespace` before any update below, so a typo fails before anything is written.
  const namespaces = await getAllNamespaces({ db });
  const namespaceIds = namespaces.map(({ id }) => id);
  const requestedNamespace =
    options.reattach && options.namespace
      ? pickNamespaceId(namespaces, options.namespace)
      : undefined;

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
      ? (resolveTaskspacePath(record.path, record.pathKind, root) ?? "(invalid path)")
      : "(none)";
    console.log(`    old: ${oldAbsolute}`);
    console.log(`    new: ${scanned.path}`);
    if (options.apply) {
      const { pathKind, storedPath } = storedLocation(root, scanned.path);
      await db
        .update(taskspaceTable)
        .set({ path: storedPath, pathKind, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(taskspaceTable.id, record.id));
      updated++;
    }
  }

  const existingNamespaces = new Set(namespaceIds);
  // Picked from the list above, only when an orphan's namespace has been deleted.
  const workspaceDefault = () => pickNamespaceId(namespaces);

  let failed = 0;
  for (const taskspace of diff.orphans) {
    console.log(`  orphan  ${shortId(taskspace.taskspaceId, taskspaceIds)}  ${taskspace.path}`);
    if (options.apply && options.reattach) {
      try {
        const placement = reattachNamespace(taskspace.namespaceId, {
          requested: requestedNamespace,
          existing: existingNamespaces,
          workspaceDefault,
        });
        const { pathKind, storedPath } = storedLocation(root, taskspace.path);
        await db.insert(taskspaceTable).values({
          id: taskspace.taskspaceId,
          namespaceId: placement.namespaceId,
          name: basename(taskspace.path),
          path: storedPath,
          pathKind,
          lastSeenAt: new Date(),
        });
        if (
          placement.namespaceId === taskspace.namespaceId ||
          placement.namespaceId === undefined
        ) {
          console.log(`    → reattached`);
        } else {
          const target = namespaces.find(({ id }) => id === placement.namespaceId);
          const label = `"${target?.name ?? placement.namespaceId}"`;
          console.log(
            placement.reason === "missing"
              ? `    → reattached to namespace ${label} (its namespace ` +
                  `${shortId(taskspace.namespaceId, [...namespaceIds, taskspace.namespaceId])} ` +
                  `no longer exists)`
              : `    → reattached to namespace ${label}`,
          );
          // Keep the marker in step with the record, so a later reattach lands in the same
          // namespace. The record is already in, so a failed write is only a warning.
          try {
            rewriteMarkerNamespace(taskspace.path, taskspace.taskspaceId, placement.namespaceId);
          } catch (e) {
            console.log(
              `    ! could not update ${TASKSPACE_MARKER_FILE}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        updated++;
      } catch (e) {
        // Report it and keep going, so one bad orphan does not block the rest.
        console.log(`    → not reattached: ${e instanceof Error ? e.message : String(e)}`);
        failed++;
      }
    }
  }

  for (const record of diff.missing) {
    const absolutePath = record.path
      ? (resolveTaskspacePath(record.path, record.pathKind, root) ?? "(invalid path)")
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
    if (failed > 0) parts.push(`${failed} failed`);
    console.log(`\nScan complete. ${parts.join(", ")}.`);
    if (failed > 0) process.exitCode = 1;
  }
}

type Placement = {
  /** Undefined leaves the taskspace in no namespace, so every board draws it. */
  namespaceId: string | undefined;
  /**
   * `marker`: the marker's namespace, which still exists. `none`: the marker names no
   * namespace. `requested`: `--namespace`. `missing`: the marker's namespace was deleted.
   */
  reason: "marker" | "none" | "requested" | "missing";
};

/**
 * Which namespace a reattached taskspace joins.
 *
 * - `--namespace` wins when given.
 * - Otherwise the marker's namespace, when it still exists. An empty one, written for a
 *   taskspace created with no namespace, stays empty.
 * - A marker naming a deleted namespace falls back to the workspace default. Inserting the
 *   deleted ID would break the foreign key and stop the whole scan.
 */
function reattachNamespace(
  markerNamespaceId: string,
  {
    requested,
    existing,
    workspaceDefault,
  }: {
    requested: string | undefined;
    existing: ReadonlySet<string>;
    /** The workspace's default namespace. Throws when there is none. */
    workspaceDefault: () => string;
  },
): Placement {
  if (requested) return { namespaceId: requested, reason: "requested" };
  if (!markerNamespaceId) return { namespaceId: undefined, reason: "none" };
  if (existing.has(markerNamespaceId)) return { namespaceId: markerNamespaceId, reason: "marker" };
  try {
    return { namespaceId: workspaceDefault(), reason: "missing" };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `its namespace no longer exists and no default is set (${why}). ` +
        `Pass --namespace <id> to choose one.`,
      { cause: e },
    );
  }
}

/**
 * Point a taskspace's `.taskspace.json` at another namespace, keeping its other fields. A file
 * that is not this taskspace's marker, such as one replaced since the scan, is left alone.
 */
function rewriteMarkerNamespace(dir: string, taskspaceId: string, namespaceId: string): void {
  const markerPath = join(dir, TASKSPACE_MARKER_FILE);
  const marker: unknown = JSON.parse(readFileSync(markerPath, "utf-8"));
  if (
    !isPlainObject(marker) ||
    marker.kind !== TASKSPACE_MARKER_KIND ||
    marker.taskspaceId !== taskspaceId
  )
    throw new Error("it is not this taskspace's marker");
  marker.namespaceId = namespaceId;
  writeFileAtomic(markerPath, JSON.stringify(marker, null, 2) + "\n");
}

// ─── taskspace create ──────────────────────────────────────────────────────────────

type CreateOptions = { scope?: string | false; namespace?: string; dir?: string };

export async function taskspaceCreate(name: string, options: CreateOptions = {}): Promise<void> {
  if (options.scope === undefined) {
    console.error("Error: --scope <scopeId> is required. Use --no-scope to create without one.");
    process.exit(1);
  }
  await runWorkspaceCommand(async ({ db, root, config }) => {
    // Let the command wrapper report resolver errors consistently.
    const scopeId =
      typeof options.scope === "string"
        ? resolveShortId(
            options.scope,
            (await db.select({ id: scopeTable.id }).from(scopeTable)).map(({ id }) => id),
            "Scope",
          )
        : undefined;

    // The name becomes the directory only without `--dir`, so only then must it be one plain
    // path segment.
    const nameIssue = options.dir ? null : taskspaceNameIssue(name);
    if (nameIssue) {
      console.error(`Error: ${nameIssue}. Use --dir to choose the directory yourself.`);
      process.exit(1);
    }
    // Loaded once: to pick the namespace, and to name and keep apart its folder.
    const namespaces = await getAllNamespaces({ db });
    const namespaceId = pickNamespaceId(namespaces, options.namespace);

    // Inside the workspace the markers on disk decide; outside it, such as with an absolute
    // defaultDir, the records do.
    const enclosingOf = async (dir: string) =>
      isStrictlyInside(resolve(root), dir)
        ? enclosingTaskspaceDir(root, dirname(dir))
        : enclosingRecordedTaskspace(root, dir, await getAllTaskspaces({ db }));

    let targetDir: string;
    if (options.dir) {
      targetDir = resolve(options.dir);
      // The user chose the directory, so it is allowed, but say so. Neither directory is lost:
      // Kozane never moves or deletes a directory that holds another taskspace.
      const enclosing = await enclosingOf(targetDir);
      if (enclosing)
        console.error(
          `Warning: ${targetDir} is inside the taskspace at ${enclosing}. Kozane will not ` +
            "move or delete that taskspace's directory while this one is in it.",
        );
    } else {
      // An ambiguous `namespacePaths` key throws, and the command wrapper reports it.
      const { defaultDir, namespaceDirs, namespacePaths } = config.taskspace;
      const parentDir = taskspaceParentDir({
        defaultDir,
        namespaceDirs,
        namespacePaths,
        namespaceId,
        namespaces,
      });
      targetDir = resolve(root, parentDir, name);
      // Never inside another taskspace's directory, which deleting that taskspace would
      // remove. The browser refuses the same.
      const enclosing = await enclosingOf(targetDir);
      if (enclosing) {
        console.error(
          `Error: ${targetDir} would be inside the taskspace at ${enclosing}. Move that ` +
            "taskspace, change taskspace.defaultDir or taskspace.namespacePaths, or use --dir.",
        );
        process.exit(1);
      }
    }
    // Where Kozane picked a directory inside the workspace, make its folders as the browser
    // does, refusing a parent that leads outside through a symlink. Otherwise the path would
    // be stored relative to the workspace while the directory lives elsewhere.
    const checkParents = !options.dir && isStrictlyInside(resolve(root), targetDir);

    if (existsSync(targetDir)) {
      const existingMarker = join(targetDir, TASKSPACE_MARKER_FILE);
      if (existsSync(existingMarker)) {
        console.error(`Directory already contains a Kozane taskspace: ${targetDir}`);
        process.exit(1);
      }
    }

    const { pathKind, storedPath } = storedLocation(root, targetDir);

    const id = await addTaskspace({
      db,
      namespaceId,
      scopeId,
      name,
      path: storedPath,
      pathKind,
      lastSeenAt: new Date(),
    });

    // Whether to make the directory. It is claimed atomically below, so a directory another
    // process makes meanwhile, such as the browser creating the same taskspace, fails the
    // create rather than being taken over.
    const makeDir = !existsSync(targetDir);
    // What this command made, so a failure removes exactly that and nothing someone else made:
    // the folders above the taskspace, such as a new namespace folder, the directory, and the
    // marker.
    let parentsCreated: string[] = [];
    let dirCreated = false;
    let markerWritten = false;
    const markerPath = join(targetDir, TASKSPACE_MARKER_FILE);
    try {
      if (checkParents) {
        const made = makeParentsInside(root, dirname(targetDir));
        if (!made)
          throw new Error(
            `${dirname(targetDir)} leads outside the workspace through a symlink. ` +
              "Use --dir to choose the directory yourself.",
          );
        parentsCreated = made;
      } else if (makeDir) {
        parentsCreated = missingDirs(dirname(targetDir));
        mkdirSync(dirname(targetDir), { recursive: true });
      }
      if (makeDir) {
        try {
          mkdirSync(targetDir);
        } catch (e) {
          if (errorCode(e) === "EEXIST")
            throw new Error(`${targetDir} was created by another process meanwhile`, {
              cause: e,
            });
          throw e;
        }
        dirCreated = true;
      }
      const marker = {
        kind: TASKSPACE_MARKER_KIND,
        version: TASKSPACE_MARKER_VERSION,
        taskspaceId: id,
        namespaceId: namespaceId ?? "",
        // Only a directory made here under `defaultDir` is Kozane's to rename or delete.
        ...(!options.dir && dirCreated && { ownsDirectory: true }),
      };
      // `wx` refuses a marker another process wrote since the check above.
      writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", { flag: "wx" });
      markerWritten = true;
    } catch (e) {
      // Clean up the record and what this command made before reporting which step failed.
      // Never recurse: anything else in the directory is not this command's to remove.
      await deleteTaskspace({ db, taskspaceId: id });
      if (markerWritten) rmSync(markerPath, { force: true });
      if (dirCreated) removeEmptyDirs([targetDir]);
      removeEmptyDirs(parentsCreated);
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

export type TaskspaceListOptions = { namespace?: string };

/**
 * List taskspaces with their namespace and scope across the workspace. `--namespace` applies
 * the board's visibility rule, including unplaced rows.
 */
export async function taskspaceList(options: TaskspaceListOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    // Resolve short IDs against all workspace taskspaces so `--namespace` does not change them.
    const all = await getAllTaskspaces({ db });
    const taskspaceIds = all.map(({ id }) => id);

    const namespaceId = options.namespace ? await resolveNamespaceId(db, options.namespace) : null;
    const taskspaces = namespaceId ? await getTaskspacesInNamespace({ db, namespaceId }) : all;
    if (taskspaces.length === 0) {
      console.log(namespaceId ? "No taskspaces found in this namespace." : "No taskspaces found.");
      return;
    }

    const namespaceNameById = new Map(
      (await getAllNamespaces({ db })).map((namespace) => [namespace.id, namespace.name]),
    );
    const scopeNameById = new Map(
      (await getAllScopes({ db })).map((scope) => [scope.id, scope.name]),
    );

    for (const taskspace of taskspaces) {
      // An em dash denotes no assignment. Unplaced taskspaces appear on every board, while
      // unscoped taskspaces gather no cards.
      const namespace = taskspace.namespaceId
        ? (namespaceNameById.get(taskspace.namespaceId) ?? taskspace.namespaceId)
        : "—";
      const scope = taskspace.scopeId
        ? (scopeNameById.get(taskspace.scopeId) ?? taskspace.scopeId)
        : "—";
      const path = taskspace.path
        ? (resolveTaskspacePath(taskspace.path, taskspace.pathKind, root) ?? "(invalid path)")
        : "(no path)";
      console.log(
        `${shortId(taskspace.id, taskspaceIds)}  ${taskspace.name || "(unnamed)"}  ${namespace}  ${scope}  ${path}`,
      );
    }
  });
}
