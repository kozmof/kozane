import type {
  CardCreateResult,
  CardSquashResult,
  CardUpdateResult,
  GlueCreateResult,
  GlueRemoveResult,
} from "../../packages/client/src/backend/index.js";
export const baseCard = {
  id: "c",
  partitionId: "p",
  layerId: "l",
  content: "Text",
  posX: 0,
  posY: 0,
  zIndex: 0,
  taskspaceId: null,
  glueId: null,
  width: null,
  inventory: null,
};
export const cardResults = {
  "cards.create": { ...baseCard, placements: [] } satisfies CardCreateResult,
  "cards.update": { ok: true, stacking: [] } satisfies CardUpdateResult,
  "cards.updatePositions": { ok: true },
  "cards.remove": { ok: true },
  "cards.removeOne": { ok: true },
  "cards.move": { ok: true },
  "cards.setLayer": { ok: true, stacking: [{ cardId: "c", zIndex: 1 }] },
  "cards.setPartition": { ok: true },
  "cards.setStacking": { ok: true, stacking: [{ cardId: "c", zIndex: 1 }] },
  "cards.squash": {
    inventory: { id: "i", namespaceId: "n /", name: "Squash 1", posX: 0, posY: 0 },
    cards: [
      {
        ...baseCard,
        id: "piece-1",
        createdAt: new Date("2026-11-05T00:00:00Z"),
        updatedAt: new Date("2026-11-05T00:00:00Z"),
        inventory: { id: "i", slot: 0 },
      },
      {
        ...baseCard,
        id: "piece-2",
        createdAt: new Date("2026-11-05T00:00:00Z"),
        updatedAt: new Date("2026-11-05T00:00:00Z"),
        inventory: { id: "i", slot: 1 },
      },
    ],
    stacking: [],
  } satisfies CardSquashResult,
  "glues.create": { glueId: "g", clearedCardIds: [] } satisfies GlueCreateResult,
  "glues.remove": { ok: true, clearedCardIds: [] } satisfies GlueRemoveResult,
};
