import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { eq } from "drizzle-orm";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import {
  scanWorkingCopies,
  resolveWorkingCopyPath,
  WC_MARKER_DIR,
  WC_MARKER_FILE,
  WC_MARKER_KIND,
  WC_MARKER_VERSION,
} from "../lib/wc-scan.js";
import { workingCopyTable, projectTable } from "../../db/schema.js";
import { v7 as uuidv7 } from "uuid";

// ─── wc scan ────────────────────────────────────────────────────────────────

type ScanOptions = { reattach?: boolean };

export async function wcScan(options: ScanOptions = {}): Promise<void> {
  const { root, config } = requireWorkspace();
  const db = await openDb(dbUrl(resolve(root)));

  const searchRoots = config.workingCopy.searchRoots.map((r) =>
    isAbsolute(r) ? r : join(root, r),
  );

  const found = scanWorkingCopies(searchRoots);
  const dbRecords = await db.select().from(workingCopyTable);
  const byId = new Map(dbRecords.map((r) => [r.id, r]));

  let updated = 0;
  let orphans = 0;

  for (const wc of found) {
    const record = byId.get(wc.workingCopyId);

    if (!record) {
      orphans++;
      console.log(`  orphan  ${wc.workingCopyId}  ${wc.path}`);
      if (options.reattach) {
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
      continue;
    }

    const pathKind = wc.path.startsWith(root)
      ? ("project_relative" as const)
      : ("absolute" as const);
    const storedPath = pathKind === "project_relative" ? relative(root, wc.path) : wc.path;

    if (record.path !== storedPath || record.pathKind !== pathKind) {
      console.log(`  moved   ${wc.workingCopyId}`);
      const oldAbsolute = record.path
        ? resolveWorkingCopyPath(record.path, record.pathKind, root)
        : "(none)";
      console.log(`    old: ${oldAbsolute}`);
      console.log(`    new: ${wc.path}`);
      await db
        .update(workingCopyTable)
        .set({ path: storedPath, pathKind, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(workingCopyTable.id, wc.workingCopyId));
      updated++;
    } else {
      console.log(`  ok      ${wc.workingCopyId}  ${wc.path}`);
      await db
        .update(workingCopyTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(workingCopyTable.id, wc.workingCopyId));
    }
  }

  // Report DB records with no matching marker found
  const foundIds = new Set(found.map((f) => f.workingCopyId));
  for (const record of dbRecords) {
    if (!foundIds.has(record.id)) {
      const absolutePath = record.path
        ? resolveWorkingCopyPath(record.path, record.pathKind, root)
        : "(no path)";
      console.log(`  missing ${record.id}  ${absolutePath}`);
    }
  }

  console.log(`\nScan complete. ${updated} updated, ${orphans} orphan(s).`);
}

// ─── wc create ──────────────────────────────────────────────────────────────

type CreateOptions = { scope?: string; dir?: string };

export async function wcCreate(name: string, options: CreateOptions = {}): Promise<void> {
  const { root, config } = requireWorkspace();
  const db = await openDb(dbUrl(resolve(root)));

  const targetDir = options.dir
    ? resolve(options.dir)
    : resolve(root, config.workingCopy.defaultDir, name);

  if (existsSync(targetDir)) {
    const existingMarker = join(targetDir, WC_MARKER_DIR, WC_MARKER_FILE);
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

  mkdirSync(join(targetDir, WC_MARKER_DIR), { recursive: true });
  const marker = {
    kind: WC_MARKER_KIND,
    version: WC_MARKER_VERSION,
    workingCopyId: id,
    projectId: projectId ?? "",
  };
  writeFileSync(
    join(targetDir, WC_MARKER_DIR, WC_MARKER_FILE),
    JSON.stringify(marker, null, 2) + "\n",
  );

  console.log(`Working copy created.`);
  console.log(`  id   : ${id}`);
  console.log(`  name : ${name}`);
  console.log(`  path : ${targetDir}`);
}
