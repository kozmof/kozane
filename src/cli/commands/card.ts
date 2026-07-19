import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { createDb } from "../../db/client.js";
import { bundleTable, cardTable, projectTable } from "../../db/schema.js";
import { addCard } from "../../db/api/card.js";
import { getDefaultBundle } from "../../db/api/bundle.js";
import { getCardsByScopeWithBundleName } from "../../db/api/scope-rel.js";
import { getWorkingCopy } from "../../db/api/working-copy.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { readWorkingCopyMarker } from "../lib/working-copy-marker.js";
import type { DB } from "../../db/tx.js";

type CardOptions = { project?: string; bundle?: string; workingCopy?: string };
type CardAddOptions = Omit<CardOptions, "workingCopy"> & { x?: number; y?: number };
type ListedCard = {
  id: string;
  bundle: string;
  content: string;
  posX: number;
  posY: number;
};

async function resolveProjectId(db: DB, requestedId?: string): Promise<string> {
  const projects = await db.select({ id: projectTable.id }).from(projectTable);
  if (requestedId)
    return resolveShortId(
      requestedId,
      projects.map(({ id }) => id),
      "Project",
    );
  if (projects.length === 0)
    throw new Error('No projects found. Run "kozane project create <name>" first.');
  if (projects.length > 1)
    throw new Error("Workspace has multiple projects. Use --project <projectId> to specify one.");
  return projects[0].id;
}

async function resolveBundleId(db: DB, projectId: string, requestedId?: string): Promise<string> {
  if (requestedId) {
    const bundles = await db
      .select({ id: bundleTable.id })
      .from(bundleTable)
      .where(eq(bundleTable.projectId, projectId));
    return resolveShortId(
      requestedId,
      bundles.map(({ id }) => id),
      "Bundle",
    );
  }
  const bundle = await getDefaultBundle({ db, projectId });
  if (!bundle) throw new Error(`Project has no default bundle: ${projectId}`);
  return bundle.id;
}

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function printCards(db: DB, cards: ListedCard[]): Promise<void> {
  if (cards.length === 0) {
    console.log("No cards found.");
    return;
  }
  const allCards = await db.select({ id: cardTable.id }).from(cardTable);
  const cardIds = allCards.map(({ id }) => id);
  for (const card of cards) {
    console.log(
      `${shortId(card.id, cardIds)}  ${card.bundle}  (${card.posX}, ${card.posY})  ${card.content.replace(/\r?\n/g, " ")}`,
    );
  }
}

export async function cardAdd(content: string, options: CardAddOptions = {}): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(dbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const bundleId = await resolveBundleId(db, projectId, options.bundle);
    const id = await addCard({ db, bundleId, content, posX: options.x, posY: options.y });
    const [projects, bundles, cards] = await Promise.all([
      db.select({ id: projectTable.id }).from(projectTable),
      db.select({ id: bundleTable.id }).from(bundleTable),
      db.select({ id: cardTable.id }).from(cardTable),
    ]);
    console.log("Card added.");
    console.log(
      `  id      : ${shortId(
        id,
        cards.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  project : ${shortId(
        projectId,
        projects.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  bundle  : ${shortId(
        bundleId,
        bundles.map(({ id }) => id),
      )}`,
    );
  } catch (error) {
    fail(error);
  }
}

export async function cardList(options: CardOptions = {}): Promise<void> {
  try {
    if (options.workingCopy && (options.project || options.bundle))
      throw new Error("--working-copy cannot be combined with --project or --bundle.");

    const { root } = requireWorkspace();
    const db = await createDb(dbUrl(resolve(root)));
    const locatedMarker =
      options.workingCopy || (!options.project && !options.bundle)
        ? readWorkingCopyMarker(options.workingCopy)
        : null;

    if (locatedMarker) {
      const workingCopy = await getWorkingCopy({
        db,
        workingCopyId: locatedMarker.marker.workingCopyId,
      });
      if (!workingCopy)
        throw new Error(`Working copy is not registered in this workspace: ${locatedMarker.path}`);
      if (workingCopy.scopeId) {
        const scopedCards = await getCardsByScopeWithBundleName({
          db,
          scopeId: workingCopy.scopeId,
        });
        await printCards(
          db,
          scopedCards.map((card) => ({ ...card, bundle: card.bundleName })),
        );
      } else {
        console.warn(
          "Notice: Working copy is not attached to a scope. The scope may have been deleted.",
        );
        const workingCopyCards = await db
          .select({
            id: cardTable.id,
            bundle: bundleTable.name,
            content: cardTable.content,
            posX: cardTable.posX,
            posY: cardTable.posY,
          })
          .from(cardTable)
          .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
          .where(eq(cardTable.workingCopyId, workingCopy.id));
        await printCards(db, workingCopyCards);
      }
      return;
    }

    const projectId = await resolveProjectId(db, options.project);
    const conditions = [eq(bundleTable.projectId, projectId)];
    if (options.bundle) {
      const bundleId = await resolveBundleId(db, projectId, options.bundle);
      conditions.push(eq(bundleTable.id, bundleId));
    }
    const cards = await db
      .select({
        id: cardTable.id,
        bundle: bundleTable.name,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(and(...conditions));
    await printCards(db, cards);
  } catch (error) {
    fail(error);
  }
}
