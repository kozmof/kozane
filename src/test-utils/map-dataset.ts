import type { MapResult } from "../lib/backend/contract.js";

/** Small complete map dataset for shared view and standalone consumer checks. */
export function mapDataset(name = "Seed partition"): MapResult {
  return {
    namespaces: [
      { id: "p1", name: "First namespace", isDefault: true },
      { id: "p2", name: "Second namespace", isDefault: false },
    ],
    partitions: [
      { id: "b1", namespaceId: "p1", name, isDefault: true, cards: 6, bg: "#eee", dot: "#123456" },
      {
        id: "b2",
        namespaceId: "p2",
        name: "Other partition",
        isDefault: true,
        cards: 4,
        bg: "#eee",
        dot: "#654321",
      },
    ],
    scopes: [],
    activity: [],
    partitionUsage: [],
    namespaceUsage: [],
    tags: { hits: [], cardData: {}, cardNamespaces: {}, truncated: false },
  };
}
