import { describe, expect, it, vi } from "vitest";
import {
  patchCardPositions,
  createCard,
  updateCard,
  deleteCard,
  glueCards,
  unglueCards,
  createBundle,
  deleteBundle,
  createScope,
  deleteScope,
  addCardsToScope,
  removeCardsFromScope,
  createWorkingCopy,
} from "./project-api.js";

function makeFetcher() {
  const response = new Response(null, { status: 200 });
  return { fetcher: vi.fn().mockResolvedValue(response), response };
}

describe("patchCardPositions", () => {
  it("sends card positions to the project cards collection endpoint", async () => {
    const response = new Response(null, { status: 200 });
    const fetcher = vi.fn().mockResolvedValue(response);
    const positions = [
      { cardId: "card-1", posX: 24, posY: 48 },
      { cardId: "card-2", posX: 72, posY: 96 },
    ];

    await expect(patchCardPositions(fetcher, "project-1", positions)).resolves.toBe(response);

    expect(fetcher).toHaveBeenCalledWith("/project-1/api/cards", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    });
  });
});

describe("createCard", () => {
  it("POSTs card data to the project cards endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    const card = { bundleId: "b-1", content: "Hello", posX: 10, posY: 20 };
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

describe("createBundle", () => {
  it("POSTs bundle name to the bundles endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(createBundle(fetcher, "p-1", "My Bundle")).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Bundle" }),
    });
  });
});

describe("deleteBundle", () => {
  it("sends DELETE to the specific bundle endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    await expect(deleteBundle(fetcher, "p-1", "b-1")).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/bundles/b-1", { method: "DELETE" });
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

describe("createWorkingCopy", () => {
  it("POSTs working copy data to the working-copies endpoint", async () => {
    const { fetcher, response } = makeFetcher();
    const wc = { name: "my-wc", scopeId: "s-1" };
    await expect(createWorkingCopy(fetcher, "p-1", wc)).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/p-1/api/working-copies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wc),
    });
  });
});
