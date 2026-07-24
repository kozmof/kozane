import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { requireWorkspace } from "../lib/project.js";
import { commandDbUrl } from "../lib/config.js";
import { createDb } from "../../db/client.js";
import { bundleTable, cardTable, projectTable, scopeTable } from "../../db/schema.js";
import { addCard } from "../../db/api/card.js";
import { getDefaultBundle } from "../../db/api/bundle.js";
import { addScopeRel, getCardsByScopeWithBundleName } from "../../db/api/scope-rel.js";
import { getWorkingCopy } from "../../db/api/working-copy.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { readWorkingCopyMarker } from "../lib/working-copy-marker.js";
import { withTx, type DB } from "../../db/tx.js";
import { CANVAS_W } from "../../lib/constants.js";

type CardOptions = { project?: string; bundle?: string; workingCopy?: string };
type CardAddOptions = Omit<CardOptions, "workingCopy"> & {
  scope?: string;
  x?: number;
  y?: number;
};
type CardSquashOptions = Omit<CardAddOptions, "x" | "y">;

type ListedCard = {
  id: string;
  bundle: string;
  content: string;
  posX: number;
  posY: number;
};
type DistanceListedCard = ListedCard & { distance: number };

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

async function resolveScopeId(db: DB, requestedId: string): Promise<string> {
  const scopes = await db.select({ id: scopeTable.id }).from(scopeTable);
  return resolveShortId(
    requestedId,
    scopes.map(({ id }) => id),
    "Scope",
  );
}

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export function splitCardContent(content: string): string[] {
  return content
    .split(/[.。]|\r?\n[ \t]*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const SQUASH_COLUMN_SPACING = 280;
const SQUASH_ROW_SPACING = 160;
const SQUASH_COLUMNS = Math.floor(CANVAS_W / SQUASH_COLUMN_SPACING);

type CardPosition = { posX: number; posY: number };

export function squashCardPositions(occupied: CardPosition[], count: number): CardPosition[] {
  const occupiedKeys = new Set(occupied.map(({ posX, posY }) => `${posX},${posY}`));
  const positions: CardPosition[] = [];
  for (let slot = 0; positions.length < count; slot++) {
    const position = {
      posX: (slot % SQUASH_COLUMNS) * SQUASH_COLUMN_SPACING,
      posY: Math.floor(slot / SQUASH_COLUMNS) * SQUASH_ROW_SPACING,
    };
    const key = `${position.posX},${position.posY}`;
    if (occupiedKeys.has(key)) continue;
    occupiedKeys.add(key);
    positions.push(position);
  }
  return positions;
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

async function printCardsWithDistance(db: DB, cards: DistanceListedCard[]): Promise<void> {
  if (cards.length === 0) {
    console.log("No cards found.");
    return;
  }
  const allCards = await db.select({ id: cardTable.id }).from(cardTable);
  const cardIds = allCards.map(({ id }) => id);
  for (const card of cards) {
    console.log(
      `${shortId(card.id, cardIds)}  ${card.bundle}  (${card.posX}, ${card.posY})  ${card.distance.toFixed(2)}  ${card.content.replace(/\r?\n/g, " ")}`,
    );
  }
}

export async function cardAdd(content: string, options: CardAddOptions = {}): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const bundleId = await resolveBundleId(db, projectId, options.bundle);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    const id = await withTx(db, async (tx) => {
      const cardId = await addCard({
        db: tx,
        bundleId,
        content,
        posX: options.x,
        posY: options.y,
      });
      if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
      return cardId;
    });
    const [projects, bundles, cards, scopes] = await Promise.all([
      db.select({ id: projectTable.id }).from(projectTable),
      db.select({ id: bundleTable.id }).from(bundleTable),
      db.select({ id: cardTable.id }).from(cardTable),
      scopeId ? db.select({ id: scopeTable.id }).from(scopeTable) : Promise.resolve([]),
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
    if (scopeId)
      console.log(
        `  scope   : ${shortId(
          scopeId,
          scopes.map(({ id }) => id),
        )}`,
      );
  } catch (error) {
    fail(error);
  }
}

export async function cardSquash(
  content: string | undefined,
  options: CardSquashOptions = {},
): Promise<void> {
  try {
    const contents = splitCardContent(content ?? readFileSync(0, "utf8"));
    if (contents.length === 0) throw new Error("Content must contain at least one non-empty card.");

    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const bundleId = await resolveBundleId(db, projectId, options.bundle);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    const occupied = await db
      .select({ posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(eq(bundleTable.projectId, projectId));
    const positions = squashCardPositions(occupied, contents.length);
    const ids = await withTx(db, async (tx) => {
      const cardIds: string[] = [];
      for (const [index, cardContent] of contents.entries()) {
        const cardId = await addCard({
          db: tx,
          bundleId,
          content: cardContent,
          ...positions[index],
        });
        if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
        cardIds.push(cardId);
      }
      return cardIds;
    });

    const allCards = await db.select({ id: cardTable.id }).from(cardTable);
    const allCardIds = allCards.map(({ id }) => id);
    console.log(`${ids.length} ${ids.length === 1 ? "card" : "cards"} added.`);
    for (const id of ids) console.log(`  ${shortId(id, allCardIds)}`);
  } catch (error) {
    fail(error);
  }
}

export async function cardShow(requestedId: string): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const cards = await db.select({ id: cardTable.id, content: cardTable.content }).from(cardTable);
    const cardId = resolveShortId(
      requestedId,
      cards.map(({ id }) => id),
      "Card",
    );
    const card = cards.find(({ id }) => id === cardId)!;
    console.log(card.content);
  } catch (error) {
    fail(error);
  }
}

export async function cardNearest(requestedId: string): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const cards = await db
      .select({
        id: cardTable.id,
        projectId: bundleTable.projectId,
        bundle: bundleTable.name,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id));
    const cardId = resolveShortId(
      requestedId,
      cards.map(({ id }) => id),
      "Card",
    );
    const origin = cards.find(({ id }) => id === cardId)!;
    const sorted = cards
      .filter(({ projectId }) => projectId === origin.projectId)
      .map((card) => ({
        ...card,
        distance: Math.hypot(card.posX - origin.posX, card.posY - origin.posY),
      }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    await printCardsWithDistance(db, sorted);
  } catch (error) {
    fail(error);
  }
}

export async function cardList(options: CardOptions = {}): Promise<void> {
  try {
    if (options.workingCopy && (options.project || options.bundle))
      throw new Error("--working-copy cannot be combined with --project or --bundle.");

    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
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
