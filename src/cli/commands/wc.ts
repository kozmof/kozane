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
import { v7 as uuidv7 } from "uuid";

// ─── wc scan ────────────────────────────────────────────────────────────────

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
  for (const wc of found) {
    if (movedIds.has(wc.workingCopyId) || orphanIds.has(wc.workingCopyId)) continue;
    console.log(`  ok      ${wc.workingCopyId}  ${wc.path}`);
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

type CreateOptions = { scope?: string; noScope?: boolean; dir?: string };

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

  // Get the project id from the DB (first project, or from scope's bundle)
  let projectId: string | undefined;
  const projects = await db.select({ id: projectTable.id }).from(projectTable).limit(1);
  if (projects.length > 0) projectId = projects[0].id;

  const id = uuidv7();
  await db.insert(workingCopyTable).values({
    id,
    projectId: projectId ?? null,
    scopeId: options.scope ?? null,
    name,
    path: storedPath,
    pathKind,
    lastSeenAt: new Date(),
  });

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
