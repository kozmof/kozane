import { expect, it, vi } from "vitest";
import {
  arrivalWarp,
  clearArrivalParams,
  readArrival,
} from "../../../../../client/src/board/lib/board-arrival.js";
import {
  createDemoNavigation,
  createNodeNavigation,
} from "../../../../../client/src/navigation.js";
import { data } from "../page.fixtures.js";
import type { Inventory, TaskspaceSummary } from "$lib/types.js";
it("resolves a stored card and file from one arrival before either selector is cleared", () => {
  const navigation = createDemoNavigation();
  const taskspace: TaskspaceSummary = {
    id: "t1",
    name: "Notes",
    scopeId: null,
    path: "notes",
    pathKind: "workspace_relative",
  };
  const inventory: Inventory = {
    id: "i1",
    namespaceId: "namespace-1",
    name: "Tray",
    posX: 1,
    posY: 2,
  };
  const board = {
    cards: [{ ...data.cards[0], inventory: { id: "i1", slot: 0 } }],
    taskspaces: [taskspace],
    inventories: [inventory],
  };
  const params = navigation.readBoard(
    new URL(
      "https://example.test/board/?namespaceId=namespace-1&card=card-1&taskspace=t1#path=notes.md",
    ),
  );
  const result = readArrival(params, board, true);
  expect(result.card?.id).toBe("card-1");
  expect(result.inventory).toEqual(inventory);
  expect(result.file).toEqual({ taskspace, path: "notes.md" });
  expect(result.handled).toEqual(["taskspace", "path", "card"]);
  expect(readArrival(params, board, (row) => row.id === "t1").file).toEqual({
    taskspace,
    path: "notes.md",
  });
  expect(readArrival(params, board, () => false).handled).toEqual(["card"]);
  expect(readArrival(params, board, false).file).toBeNull();
  expect(readArrival(params, board, false).handled).toEqual(["card"]);
});
it("keeps unknown destinations unhandled and matches warps only on the current board", () => {
  const result = readArrival(
    { card: "missing", taskspace: "missing", path: "notes.md" },
    { cards: data.cards, taskspaces: [], inventories: [] },
    true,
  );
  expect(result.handled).toEqual([]);
  expect(arrivalWarp({ warp: "warp-1" }, data.warps)?.id).toBe("warp-1");
  expect(arrivalWarp({ warp: "missing" }, data.warps)).toBeNull();
});
it("uses supplied history replacement and tolerates cosmetic routing failures", () => {
  const replace = vi.fn();
  const url = new URL("https://example.test/ns?card=c1&scope=reading#keep");
  clearArrivalParams(url, ["card"], createNodeNavigation(), replace);
  expect(replace).toHaveBeenCalledWith("/ns?scope=reading#keep");
  expect(() =>
    clearArrivalParams(url, ["card"], createNodeNavigation(), () => {
      throw new Error("router stopped");
    }),
  ).not.toThrow();
});
