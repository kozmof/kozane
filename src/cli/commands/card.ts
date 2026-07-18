import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { createDb } from "../../db/client.js";
import { bundleTable, cardTable, projectTable } from "../../db/schema.js";
import { addCard } from "../../db/api/card.js";
import { getDefaultBundle } from "../../db/api/bundle.js";
import type { DB } from "../../db/tx.js";

type CardOptions = { project?: string; bundle?: string };

async function resolveProjectId(db: DB, requestedId?: string): Promise<string> {
  if (requestedId) {
    const project = await db
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.id, requestedId))
      .get();
    if (!project) throw new Error(`Project not found: ${requestedId}`);
    return project.id;
  }
  const projects = await db.select({ id: projectTable.id }).from(projectTable);
  if (projects.length === 0)
    throw new Error('No projects found. Run "kozane project create <name>" first.');
  if (projects.length > 1)
    throw new Error("Workspace has multiple projects. Use --project <projectId> to specify one.");
  return projects[0].id;
}

async function resolveBundleId(db: DB, projectId: string, requestedId?: string): Promise<string> {
  if (requestedId) {
    const bundle = await db
      .select({ id: bundleTable.id })
      .from(bundleTable)
      .where(and(eq(bundleTable.id, requestedId), eq(bundleTable.projectId, projectId)))
      .get();
    if (!bundle) throw new Error(`Bundle not found in project ${projectId}: ${requestedId}`);
    return bundle.id;
  }
  const bundle = await getDefaultBundle({ db, projectId });
  if (!bundle) throw new Error(`Project has no default bundle: ${projectId}`);
  return bundle.id;
}

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export async function cardAdd(content: string, options: CardOptions = {}): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(dbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const bundleId = await resolveBundleId(db, projectId, options.bundle);
    const id = await addCard({ db, bundleId, content });
    console.log("Card added.");
    console.log(`  id      : ${id}`);
    console.log(`  project : ${projectId}`);
    console.log(`  bundle  : ${bundleId}`);
  } catch (error) {
    fail(error);
  }
}

export async function cardList(options: CardOptions = {}): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(dbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const conditions = [eq(bundleTable.projectId, projectId)];
    if (options.bundle) {
      await resolveBundleId(db, projectId, options.bundle);
      conditions.push(eq(bundleTable.id, options.bundle));
    }
    const cards = await db
      .select({ id: cardTable.id, bundle: bundleTable.name, content: cardTable.content })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(and(...conditions));
    if (cards.length === 0) {
      console.log("No cards found.");
      return;
    }
    for (const card of cards) {
      console.log(`${card.id}  ${card.bundle}  ${card.content.replace(/\r?\n/g, " ")}`);
    }
  } catch (error) {
    fail(error);
  }
}
