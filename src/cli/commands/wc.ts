import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { eq } from "drizzle-orm";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import {
  scanWorkingCopies,
  diffWorkingCopies,
  resolveWorkingCopyPath,
  WC_MARKER_FILE,
  WC_MARKER_KIND,
  WC_MARKER_VERSION,
} from "../lib/wc-scan.js";
import { workingCopyTable, projectTable } from "../../db/schema.js";
import { addWorkingCopy } from "../../db/api/working-copy.js";
import { addProjectScopeRel } from "../../db/api/scope.js";

// ─── wc scan ────────────────────────────────────────────────────────────────

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

export async function wcScan(options: ScanOptions = {}): Promise<void> {
  if (options.reattach && !options.apply) {
    console.error("Error: --reattach requires --apply");
    process.exit(1);
  }
  if (options.cleanup && !options.apply) {
    console.error("Error: --cleanup requires --apply");
    process.exit(1);
  }

  const { root, config } = requireWorkspace();
  const db = await openDb(dbUrl(resolve(root)));

  const searchRoots = config.workingCopy.searchRoots.map((r) =>
    isAbsolute(r) ? r : join(root, r),
  );

  const found = scanWorkingCopies(searchRoots);
  const dbRecords = await db.select().from(workingCopyTable);
  const diff = diffWorkingCopies(found, dbRecords, root);

  let updated = 0;
  let deleted = 0;

  const movedIds = new Set(diff.moved.map(({ record }) => record.id));
  const orphanIds = new Set(diff.orphans.map((wc) => wc.workingCopyId));
  const recordById = new Map(dbRecords.map((r) => [r.id, r]));
  const now = Date.now();
  for (const wc of found) {
    if (movedIds.has(wc.workingCopyId) || orphanIds.has(wc.workingCopyId)) continue;
    const record = recordById.get(wc.workingCopyId);
    const seenSuffix = record?.lastSeenAt
      ? `  (last seen ${formatAge(now - record.lastSeenAt.getTime())} ago)`
      : "  (never seen)";
    console.log(`  ok      ${wc.workingCopyId}  ${wc.path}${seenSuffix}`);
    if (options.apply) {
      await db
        .update(workingCopyTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(workingCopyTable.id, wc.workingCopyId));
    }
  }

  for (const { record, scanned } of diff.moved) {
    console.log(`  moved   ${record.id}`);
    const oldAbsolute = record.path
      ? resolveWorkingCopyPath(record.path, record.pathKind, root)
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
        .update(workingCopyTable)
        .set({ path: storedPath, pathKind, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(workingCopyTable.id, record.id));
      updated++;
    }
  }

  for (const wc of diff.orphans) {
    console.log(`  orphan  ${wc.workingCopyId}  ${wc.path}`);
    if (options.apply && options.reattach) {
      const pathKind = wc.path.startsWith(root)
        ? ("project_relative" as const)
        : ("absolute" as const);
      const storedPath = pathKind === "project_relative" ? relative(root, wc.path) : wc.path;
      await db.insert(workingCopyTable).values({
        id: wc.workingCopyId,
        projectId: wc.projectId,
        name: wc.workingCopyId,
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
      ? resolveWorkingCopyPath(record.path, record.pathKind, root)
      : "(no path)";
    console.log(`  missing ${record.id}  ${absolutePath}`);
    if (options.apply && options.cleanup) {
      await db.delete(workingCopyTable).where(eq(workingCopyTable.id, record.id));
      console.log(`    → deleted`);
      deleted++;
    }
  }

  if (!options.apply) {
    const hints: string[] = [];
    if (diff.moved.length > 0)
      hints.push(`  wc scan --apply             update ${diff.moved.length} moved path(s)`);
    if (diff.orphans.length > 0)
      hints.push(`  wc scan --apply --reattach  reattach ${diff.orphans.length} orphan(s)`);
    if (diff.missing.length > 0)
      hints.push(`  wc scan --apply --cleanup   delete ${diff.missing.length} missing record(s)`);
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

// ─── wc create ──────────────────────────────────────────────────────────────

type CreateOptions = { scope?: string; noScope?: boolean; project?: string; dir?: string };

export async function wcCreate(name: string, options: CreateOptions = {}): Promise<void> {
  if (!options.scope && !options.noScope) {
    console.error("Error: --scope <scopeId> is required. Use --no-scope to create without one.");
    process.exit(1);
  }
  const { root, config } = requireWorkspace();
  const db = await openDb(dbUrl(resolve(root)));

  const targetDir = options.dir
    ? resolve(options.dir)
    : resolve(root, config.workingCopy.defaultDir, name);

  if (existsSync(targetDir)) {
    const existingMarker = join(targetDir, WC_MARKER_FILE);
    if (existsSync(existingMarker)) {
      console.error(`Directory already contains a Kozane working copy: ${targetDir}`);
      process.exit(1);
    }
  }

  const pathKind = targetDir.startsWith(resolve(root))
    ? ("project_relative" as const)
    : ("absolute" as const);
  const storedPath =
    pathKind === "project_relative" ? relative(resolve(root), targetDir) : targetDir;

  let projectId: string | undefined;
  if (options.project) {
    const found = await db
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.id, options.project))
      .get();
    if (!found) {
      console.error(`Error: project not found: ${options.project}`);
      process.exit(1);
    }
    projectId = found.id;
  } else {
    const projects = await db.select({ id: projectTable.id }).from(projectTable);
    if (projects.length === 1) {
      projectId = projects[0].id;
    } else if (projects.length > 1) {
      console.error("Error: workspace has multiple projects. Use --project <projectId> to specify one.");
      process.exit(1);
    }
  }

  const id = await addWorkingCopy({
    db,
    projectId,
    scopeId: options.scope,
    name,
    path: storedPath,
    pathKind,
    lastSeenAt: new Date(),
  });

  if (projectId && options.scope) {
    await addProjectScopeRel({ db, projectId, scopeId: options.scope });
  }

  mkdirSync(targetDir, { recursive: true });
  const marker = {
    kind: WC_MARKER_KIND,
    version: WC_MARKER_VERSION,
    workingCopyId: id,
    projectId: projectId ?? "",
  };
  writeFileSync(join(targetDir, WC_MARKER_FILE), JSON.stringify(marker, null, 2) + "\n");

  console.log(`Working copy created.`);
  console.log(`  id   : ${id}`);
  console.log(`  name : ${name}`);
  console.log(`  path : ${targetDir}`);
}
