import type { TagsViewData } from "../../../../src/services/tags.js";
import type { TagHit } from "../../../../src/lib/types.js";
/** A gathered dataset for client view and HTTP decoder tests. */
export function tagDataset(hits: TagHit[] = []): TagsViewData {
  const cards = [
    ...new Set(hits.flatMap((hit) => (hit.source.kind === "card" ? [hit.source.cardId] : []))),
  ];
  const taskspaces = [
    ...new Set(hits.flatMap((hit) => (hit.source.kind === "file" ? [hit.source.taskspaceId] : []))),
  ];
  return {
    namespaces: [{ id: "p1", name: "Namespace One", isDefault: true }],
    cardPartitions: cards.map((cardId) => ({
      cardId,
      partitionId: "b1",
      partitionName: "General",
    })),
    partitions: { b1: { name: "General", dot: "#abc" } },
    index: {
      hits,
      cardData: Object.fromEntries(
        cards.map((id) => [id, { namespaceId: "p1", partitionId: "b1", updatedDay: "2026-09-06" }]),
      ),
      cardNamespaces: Object.fromEntries(cards.map((id) => [id, "p1"])),
      taskspaces: Object.fromEntries(
        taskspaces.map((id) => [id, { name: "Notes", namespaceId: "p1" }]),
      ),
      truncated: [],
      missing: [],
      cardsTruncated: false,
    },
  };
}
