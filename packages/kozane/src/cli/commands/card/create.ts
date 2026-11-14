import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { storeImage, maintainImageAssets } from "../../../lib/server/image-assets.js";
import { createInTx as createBatchInTx } from "../../../services/card-batch.js";
import { createInTx } from "../../../services/cards.js";
import { createServiceContext } from "../../../services/context.js";
import { composeWrite } from "../../../db/database.js";
/** `kozane card add` and `kozane card squash`. */
import { readFileSync } from "node:fs";
import { runWorkspaceCommand } from "../../lib/workspace-command.js";
import {
  partitionTable,
  cardTable,
  inventoryTable,
  namespaceTable,
  scopeTable,
} from "../../../db/schema.js";
import { getAllLayers } from "../../../db/api/layer.js";
import { shortId, shortIdMap } from "../../lib/short-id.js";
import { resolvePartitionId, resolveLayerId, resolveScopeId } from "../../lib/card-refs.js";
import { splitCardContent } from "../../../lib/squash.js";
import { resolveNamespaceId } from "../../lib/namespace-selection.js";
import { canvasBoundsForRoot } from "../../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../../lib/server/content-limit.js";
import { type CardAddOptions, type CardSquashOptions } from "./options.js";

export async function cardAddImage(file: string, options: CardAddOptions = {}): Promise<void> {
  await addCard("", options, file);
}

export async function cardAdd(rawContent: string, options: CardAddOptions = {}): Promise<void> {
  await addCard(rawContent, options);
}

async function addCard(
  rawContent: string,
  options: CardAddOptions,
  imageFile?: string,
): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    let imagePath: string | undefined;
    if (imageFile !== undefined) {
      const stat = statSync(imageFile);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("Invalid image file");
      const path = await storeImage(root, imageFile, readFileSync(imageFile));
      imagePath = join(root, ".kozane", "assets", "images", path.split("/").pop()!);
      rawContent = "kozane-image:" + path;
    }
    const context = createServiceContext({
      contentMax: contentMaxForRoot(root),
      ...canvasBoundsForRoot(root),
    });
    // Resolve inside the writing transaction, as the HTTP route does, so a partition, layer, or
    // scope deleted by another writer in between is reported as not found rather than as a
    // foreign-key failure.
    const { id, namespaceId, partitionId, layerId, scopeId } = await composeWrite(
      db,
      async (tx) => {
        const namespaceId = await resolveNamespaceId(tx, options.namespace);
        const partitionId = await resolvePartitionId(tx, namespaceId, options.partition);
        const layerId = await resolveLayerId(tx, namespaceId, options.layer);
        const scopeId = options.scope ? await resolveScopeId(tx, options.scope) : undefined;
        const { id: cardId } = await createInTx(tx, context, namespaceId, {
          partitionId,
          layerId,
          scopeId,
          content: rawContent,
          posX: options.x ?? 0,
          posY: options.y ?? 0,
        });
        return { id: cardId, namespaceId, partitionId, layerId, scopeId };
      },
    ).catch((error) => {
      if (imagePath) unlinkSync(imagePath);
      throw error;
    });
    const [namespaces, partitions, cards, scopes, layers] = await Promise.all([
      db.select({ id: namespaceTable.id }).from(namespaceTable),
      db.select({ id: partitionTable.id }).from(partitionTable),
      db.select({ id: cardTable.id }).from(cardTable),
      scopeId ? db.select({ id: scopeTable.id }).from(scopeTable) : Promise.resolve([]),
      getAllLayers({ db, namespaceId }),
    ]);
    await maintainImageAssets(root, db);
    console.log("Card added.");
    console.log(
      `  id      : ${shortId(
        id,
        cards.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  namespace : ${shortId(
        namespaceId,
        namespaces.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  partition  : ${shortId(
        partitionId,
        partitions.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  layer   : ${shortId(
        layerId,
        layers.map(({ id }) => id),
      )}`,
    );
    if (scopeId)
      console.log(
        `  scope   : ${shortId(
          scopeId,
          scopes.map(({ id }) => id),
        )}`,
      );
  });
}

export async function cardSquash(
  content: string | undefined,
  options: CardSquashOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const contents = splitCardContent(content ?? readFileSync(0, "utf8"), options.pattern);
    const context = createServiceContext({
      contentMax: contentMaxForRoot(root),
      ...canvasBoundsForRoot(root),
    });
    const { inventory, ids } = await composeWrite(db, async (tx) => {
      const namespaceId = await resolveNamespaceId(tx, options.namespace);
      const partitionId = await resolvePartitionId(tx, namespaceId, options.partition);
      const layerId = await resolveLayerId(tx, namespaceId, options.layer);
      const scopeId = options.scope ? await resolveScopeId(tx, options.scope) : undefined;
      return createBatchInTx(tx, context, namespaceId, {
        partitionId,
        layerId,
        scopeId,
        contents,
        posX: options.x ?? 0,
        posY: options.y ?? 0,
      });
    });

    const [allCards, allInventories] = await Promise.all([
      db.select({ id: cardTable.id }).from(cardTable),
      db.select({ id: inventoryTable.id }).from(inventoryTable),
    ]);
    const shortIds = shortIdMap(allCards.map(({ id }) => id));
    console.log(
      `${ids.length} ${ids.length === 1 ? "card" : "cards"} added to inventory "${inventory.name}".`,
    );
    console.log(
      `  inventory: ${shortId(
        inventory.id,
        allInventories.map(({ id }) => id),
      )}`,
    );
    for (const id of ids) console.log(`  ${shortIds.get(id) ?? id}`);
  });
}
