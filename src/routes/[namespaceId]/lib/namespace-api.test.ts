import { describe, expect, it, vi } from "vitest";
import {
  patchCardPositions,
  createCard,
  updateCard,
  deleteCard,
  deleteCards,
  glueCards,
  unglueCards,
  createPartition,
  deletePartition,
  createScope,
  deleteScope,
  addCardsToScope,
  removeCardsFromScope,
  batchReassignPartition,
  moveCardsToNamespace,
  createTaskspace,
  parseWarp,
  parseCard,
  parseCards,
  createScopeArea,
  moveScopeArea,
  deleteScopeArea,
  parseScopeArea,
} from "./namespace-api.js";

function makeFetcher() {
  const response = new Response(null, { status: 200 });
  return { fetcher: vi.fn().mockResolvedValue(response), response };
}

describe("patchCardPositions", () => {
  it("sends card positions to the namespace cards collection endpoint", async () => {
    const response = new Response(null, { status: 200 });
    const fetcher = vi.fn().mockResolvedValue(response);
    const positions = [
      { cardId: "card-1", posX: 24, posY: 48 },
      { cardId: "card-2", posX: 72, posY: 96 },
    ];

    await expect(patchCardPositions(fetcher, "namespace-1", positions)).resolves.toBe(response);

    expect(fetcher).toHaveBeenCalledWith("/namespace-1/api/cards", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    });
  });
});

describe("createCard", () => {
  it("POSTs card data to the namespace cards endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    const card = { partitionId: "b-1", content: "Hello", posX: 10, posY: 20 };
    await expect(createCard(fetcher, "p-1", card)).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
  });
});

describe("updateCard", () => {
  it("PATCHes card fields to the specific card endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    const patch = { content: "Updated" };
    await expect(updateCard(fetcher, "p-1", "c-1", patch)).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/cards/c-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  });
});

describe("deleteCard", () => {
  it("sends DELETE to the specific card endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(deleteCard(fetcher, "p-1", "c-1")).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/cards/c-1", { method: "DELETE" });
  });
});

describe("glueCards", () => {
  it("POSTs cardIds to the glues endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(glueCards(fetcher, "p-1", ["c-1", "c-2"])).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/glues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["c-1", "c-2"] }),
    });
  });
});

describe("unglueCards", () => {
  it("sends DELETE with cardIds to the glues endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(unglueCards(fetcher, "p-1", ["c-1", "c-2"])).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/glues", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["c-1", "c-2"] }),
    });
  });
});

describe("createPartition", () => {
  it("POSTs partition name to the partitions endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(createPartition(fetcher, "p-1", "My Partition")).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/partitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Partition" }),
    });
  });
});

describe("deletePartition", () => {
  it("sends DELETE to the specific partition endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(deletePartition(fetcher, "p-1", "b-1")).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/partitions/b-1", { method: "DELETE" });
  });
});

describe("createScope", () => {
  it("POSTs scope name to the scopes endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(createScope(fetcher, "p-1", "My Scope")).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/scopes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Scope" }),
    });
  });
});

describe("deleteScope", () => {
  it("sends DELETE to the specific scope endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(deleteScope(fetcher, "p-1", "s-1")).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/scopes/s-1", { method: "DELETE" });
  });
});

describe("addCardsToScope", () => {
  it("POSTs cardIds to the scope members endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(addCardsToScope(fetcher, "p-1", "s-1", ["c-1", "c-2"])).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/scopes/s-1/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["c-1", "c-2"] }),
    });
  });
});

describe("removeCardsFromScope", () => {
  it("sends DELETE with cardIds to the scope members endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(removeCardsFromScope(fetcher, "p-1", "s-1", ["c-1"])).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/scopes/s-1/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["c-1"] }),
    });
  });
});

describe("deleteCards", () => {
  it("sends DELETE with cardIds to the cards endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(deleteCards(fetcher, "p-1", ["c-1", "c-2"])).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/cards", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["c-1", "c-2"] }),
    });
  });
});

describe("batchReassignPartition", () => {
  it("PATCHes cardIds and partitionId to the cards/partition endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(batchReassignPartition(fetcher, "p-1", ["c-1", "c-2"], "b-1")).resolves.toBe(
      response,
    );
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/cards/partition", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["c-1", "c-2"], partitionId: "b-1" }),
    });
  });
});

describe("moveCardsToNamespace", () => {
  it("POSTs cardIds and targetNamespaceId to the cards/move endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(moveCardsToNamespace(fetcher, "p-1", ["c-1", "c-2"], "p-2")).resolves.toBe(
      response,
    );
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/cards/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["c-1", "c-2"], targetNamespaceId: "p-2" }),
    });
  });
});

describe("createTaskspace", () => {
  it("POSTs taskspace data to the taskspaces endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    const taskspace = { name: "my-taskspace", scopeId: "s-1" };
    await expect(createTaskspace(fetcher, "p-1", taskspace)).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/taskspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskspace),
    });
  });
});

describe("parseWarp", () => {
  it("accepts the row a warp POST answers with", () => {
    const row = { id: "w-1", namespaceId: "p-1", posX: 120, posY: 240 };
    expect(parseWarp(row)).toEqual(row);
  });

  it("keeps only the fields a warp has", () => {
    expect(parseWarp({ id: "w-1", namespaceId: "p-1", posX: 1, posY: 2, name: "nope" })).toEqual({
      id: "w-1",
      namespaceId: "p-1",
      posX: 1,
      posY: 2,
    });
  });

  it("rejects a body that is not a warp", () => {
    expect(parseWarp(null)).toBeNull();
    expect(parseWarp("w-1")).toBeNull();
    expect(parseWarp({ ok: true })).toBeNull();
    expect(parseWarp({ id: "w-1", namespaceId: "p-1", posX: "120", posY: 240 })).toBeNull();
    expect(parseWarp({ id: "w-1", namespaceId: "p-1", posX: 120 })).toBeNull();
    expect(parseWarp({ id: 1, namespaceId: "p-1", posX: 120, posY: 240 })).toBeNull();
    expect(parseWarp({ id: "w-1", namespaceId: "p-1", posX: NaN, posY: 240 })).toBeNull();
  });
});

/**
 * The scope-area wrappers, which had been the one untested block in this file — 73% of its
 * statements and 64% of its branches, all of it here. They are thin, but "thin" is what the
 * rest of the file says too and every other wrapper is covered: what these assert is the URL
 * each one builds and the method it sends, which is exactly the thing a refactor gets wrong
 * silently and no type can catch.
 */
describe("createScopeArea", () => {
  it("POSTs the whole rectangle to the scope's areas collection", async () => {
    const { fetcher, response } = makeFetcher();
    const rect = { posX: 40, posY: 80, width: 320, height: 240 };

    await expect(createScopeArea(fetcher, "ns-1", "scope-1", rect)).resolves.toBe(response);

    expect(fetcher).toHaveBeenCalledWith("/ns-1/api/scopes/scope-1/areas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rect),
    });
  });

  it("sends the rectangle as it stands, without a delta or a wrapper key", () => {
    const { fetcher } = makeFetcher();
    void createScopeArea(fetcher, "ns-1", "scope-1", {
      posX: 0,
      posY: 0,
      width: 120,
      height: 120,
    });

    const body = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ posX: 0, posY: 0, width: 120, height: 120 });
  });
});

describe("moveScopeArea", () => {
  it("PATCHes the whole rectangle to the one frame", async () => {
    const { fetcher, response } = makeFetcher();
    const rect = { posX: 12, posY: 24, width: 200, height: 160 };

    await expect(moveScopeArea(fetcher, "ns-1", "scope-1", "area-9", rect)).resolves.toBe(response);

    expect(fetcher).toHaveBeenCalledWith("/ns-1/api/scopes/scope-1/areas/area-9", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rect),
    });
  });

  it("addresses the frame by its own id, not by its scope", () => {
    // A scope may be framed in several places, so the area id is what distinguishes them —
    // a URL built from the scope alone would move whichever frame the server found first.
    const { fetcher } = makeFetcher();
    void moveScopeArea(fetcher, "ns-1", "scope-1", "area-second", {
      posX: 1,
      posY: 2,
      width: 130,
      height: 140,
    });
    expect(fetcher.mock.calls[0][0]).toBe("/ns-1/api/scopes/scope-1/areas/area-second");
  });
});

describe("deleteScopeArea", () => {
  it("DELETEs the one frame and sends no body", async () => {
    const { fetcher, response } = makeFetcher();

    await expect(deleteScopeArea(fetcher, "ns-1", "scope-1", "area-9")).resolves.toBe(response);

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/ns-1/api/scopes/scope-1/areas/area-9");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("parseScopeArea", () => {
  it("accepts the row a scope-area write answers with", () => {
    const row = {
      id: "area-1",
      scopeId: "scope-1",
      namespaceId: "ns-1",
      posX: 40,
      posY: 80,
      width: 320,
      height: 240,
    };
    expect(parseScopeArea(row)).toEqual(row);
  });

  it("keeps only the fields a frame has", () => {
    expect(
      parseScopeArea({
        id: "area-1",
        scopeId: "scope-1",
        namespaceId: "ns-1",
        posX: 1,
        posY: 2,
        width: 130,
        height: 140,
        name: "nope",
      }),
    ).toEqual({
      id: "area-1",
      scopeId: "scope-1",
      namespaceId: "ns-1",
      posX: 1,
      posY: 2,
      width: 130,
      height: 140,
    });
  });

  it("rejects a body that is not a frame", () => {
    // Each branch of the three guards, because a frame built from a partial body is the
    // failure the function exists to stop: it would be drawn at `undefined` and would file
    // every card the next drag touched into the scope.
    const whole = {
      id: "area-1",
      scopeId: "scope-1",
      namespaceId: "ns-1",
      posX: 1,
      posY: 2,
      width: 130,
      height: 140,
    };
    expect(parseScopeArea(null)).toBeNull();
    expect(parseScopeArea("area-1")).toBeNull();
    expect(parseScopeArea({ ok: true })).toBeNull();
    for (const key of ["id", "scopeId", "namespaceId", "posX", "posY", "width", "height"]) {
      expect(parseScopeArea({ ...whole, [key]: undefined })).toBeNull();
    }
    expect(parseScopeArea({ ...whole, id: 1 })).toBeNull();
    expect(parseScopeArea({ ...whole, posX: "40" })).toBeNull();
    expect(parseScopeArea({ ...whole, height: NaN })).toBeNull();
    expect(parseScopeArea({ ...whole, width: Infinity })).toBeNull();
  });
});

describe("parseCard", () => {
  const row = {
    id: "c-1",
    partitionId: "b-1",
    layerId: "l-1",
    content: "hello",
    posX: 10,
    posY: 20,
    zIndex: 3,
    taskspaceId: null,
    glueId: null,
    width: null,
  };

  it("accepts the row a card POST answers with", () => {
    expect(parseCard(row)).toEqual(row);
  });

  it("keeps only the fields a card has", () => {
    expect(parseCard({ ...row, createdAt: "2026-01-01", nope: true })).toEqual(row);
  });

  it("accepts an empty card, which is an ordinary one", () => {
    expect(parseCard({ ...row, content: "" })).toEqual({ ...row, content: "" });
  });

  it("accepts the nullable fields when they carry a value", () => {
    const filled = { ...row, taskspaceId: "w-1", glueId: "g-1", width: 420 };
    expect(parseCard(filled)).toEqual(filled);
  });

  it("rejects a body that is not a card", () => {
    expect(parseCard(null)).toBeNull();
    expect(parseCard("c-1")).toBeNull();
    expect(parseCard({ ok: true })).toBeNull();
  });

  // The failure the annotation it replaced could not catch: a body that is *almost* a card.
  // Each of these used to reach `state.cards` and be drawn from.
  it("rejects a card missing or mistyping a field the board draws with", () => {
    expect(parseCard({ ...row, posX: undefined })).toBeNull();
    expect(parseCard({ ...row, posX: "10" })).toBeNull();
    expect(parseCard({ ...row, posY: NaN })).toBeNull();
    expect(parseCard({ ...row, zIndex: null })).toBeNull();
    expect(parseCard({ ...row, id: "" })).toBeNull();
    expect(parseCard({ ...row, layerId: 1 })).toBeNull();
    expect(parseCard({ ...row, content: 5 })).toBeNull();
    expect(parseCard({ ...row, width: "420" })).toBeNull();
    expect(parseCard({ ...row, glueId: 7 })).toBeNull();
  });
});

describe("parseCards", () => {
  const piece = (id: string) => ({
    id,
    partitionId: "b-1",
    layerId: "l-1",
    content: id,
    posX: 0,
    posY: 0,
    zIndex: 0,
    taskspaceId: null,
    glueId: null,
    width: null,
  });

  it("accepts the list a squash answers with", () => {
    const cards = [piece("c-1"), piece("c-2")];
    expect(parseCards({ cards })).toEqual(cards);
  });

  it("refuses the whole list when one element is not a card", () => {
    expect(parseCards({ cards: [piece("c-1"), { ...piece("c-2"), posX: "0" }] })).toBeNull();
    expect(parseCards({ cards: [piece("c-1"), null] })).toBeNull();
  });

  it("refuses a body with no list, or an empty one", () => {
    expect(parseCards(null)).toBeNull();
    expect(parseCards({})).toBeNull();
    expect(parseCards({ cards: {} })).toBeNull();
    expect(parseCards({ cards: [] })).toBeNull();
  });
});
