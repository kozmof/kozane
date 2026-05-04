import { describe, expect, it, vi } from "vitest";
import { patchCardPositions } from "./project-api.js";

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
