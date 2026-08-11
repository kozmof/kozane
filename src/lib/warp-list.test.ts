import { describe, expect, it } from "vitest";
import {
  buildWarpDirectory,
  groupWarpEntries,
  moveHighlight,
  nearestCardHint,
  warpEntriesForProject,
  withoutWarp,
  WARP_HINT_MAX_CHARS,
  WARP_HINT_RADIUS,
} from "./warp-list.js";
import type { WarpListEntry } from "./warp-list.js";

function warp(id: string, posX: number, posY: number, projectId = "p1") {
  return { id, projectId, posX, posY };
}

function card(posX: number, posY: number, content: string) {
  return { posX, posY, content };
}

describe("nearestCardHint", () => {
  it("names the closest card", () => {
    const hint = nearestCardHint(warp("w1", 100, 100), [
      card(400, 100, "far"),
      card(140, 120, "near"),
    ]);

    expect(hint).toBe("near");
  });

  it("ignores cards beyond the hint radius", () => {
    const justOutside = WARP_HINT_RADIUS + 1;

    expect(nearestCardHint(warp("w1", 0, 0), [card(justOutside, 0, "over there")])).toBeNull();
    expect(nearestCardHint(warp("w1", 0, 0), [card(WARP_HINT_RADIUS, 0, "on the edge")])).toBe(
      "on the edge",
    );
  });

  it("has no hint when the project has no cards", () => {
    expect(nearestCardHint(warp("w1", 0, 0), [])).toBeNull();
  });

  it("skips a card that is blank", () => {
    expect(nearestCardHint(warp("w1", 0, 0), [card(10, 0, "   \n "), card(80, 0, "real")])).toBe(
      "real",
    );
  });

  it("collapses the card down to one short line", () => {
    const hint = nearestCardHint(warp("w1", 0, 0), [card(10, 0, "  first line\n\nsecond  line ")]);

    expect(hint).toBe("first line second line");
  });

  it("truncates a long card with an ellipsis", () => {
    const hint = nearestCardHint(warp("w1", 0, 0), [card(10, 0, "x".repeat(200))]);

    expect(hint).toHaveLength(WARP_HINT_MAX_CHARS);
    expect(hint?.endsWith("…")).toBe(true);
  });

  it("keeps the first of two equally close cards", () => {
    const hint = nearestCardHint(warp("w1", 0, 0), [card(50, 0, "first"), card(-50, 0, "second")]);

    expect(hint).toBe("first");
  });
});

describe("warpEntriesForProject", () => {
  it("numbers warps from one in the order they arrive", () => {
    const entries = warpEntriesForProject({
      project: { id: "p1", name: "Kozane" },
      warps: [warp("w1", 0, 0), warp("w2", 900, 0), warp("w3", 1800, 0)],
      cards: [card(40, 0, "notes")],
      isCurrent: true,
    });

    expect(entries).toMatchObject([
      { id: "w1", label: 1, projectName: "Kozane", isCurrent: true, hint: "notes" },
      { id: "w2", label: 2, hint: null },
      { id: "w3", label: 3, hint: null },
    ]);
  });
});

describe("moveHighlight", () => {
  const entries = warpEntriesForProject({
    project: { id: "p1", name: "Kozane" },
    warps: [warp("w1", 0, 0), warp("w2", 900, 0), warp("w3", 1800, 0)],
    cards: [],
    isCurrent: true,
  });

  it("steps down and up the list", () => {
    expect(moveHighlight(entries, "w1", 1)?.id).toBe("w2");
    expect(moveHighlight(entries, "w2", -1)?.id).toBe("w1");
  });

  it("wraps round at both ends", () => {
    expect(moveHighlight(entries, "w3", 1)?.id).toBe("w1");
    expect(moveHighlight(entries, "w1", -1)?.id).toBe("w3");
  });

  it("starts at the end the movement comes from when nothing is highlighted", () => {
    expect(moveHighlight(entries, null, 1)?.id).toBe("w1");
    expect(moveHighlight(entries, null, -1)?.id).toBe("w3");
    expect(moveHighlight(entries, "gone", 1)?.id).toBe("w1");
  });

  it("has nothing to move to in an empty list", () => {
    expect(moveHighlight([], null, 1)).toBeNull();
  });
});

describe("withoutWarp", () => {
  const entries = [
    { id: "w1", projectId: "p1", label: 1 },
    { id: "w2", projectId: "p1", label: 2 },
    { id: "w3", projectId: "p1", label: 3 },
    { id: "w4", projectId: "p2", label: 1 },
  ] as WarpListEntry[];

  it("renumbers what is left of the project the warp belonged to", () => {
    expect(withoutWarp(entries, "w1")).toMatchObject([
      { id: "w2", label: 1 },
      { id: "w3", label: 2 },
      { id: "w4", label: 1 },
    ]);
  });

  it("leaves the other projects' numbers alone", () => {
    expect(withoutWarp(entries, "w4")).toMatchObject([
      { id: "w1", label: 1 },
      { id: "w2", label: 2 },
      { id: "w3", label: 3 },
    ]);
  });

  it("changes nothing for a warp that is not in the list", () => {
    expect(withoutWarp(entries, "gone")).toEqual(entries);
  });
});

describe("groupWarpEntries", () => {
  it("gathers consecutive entries of one project under one heading", () => {
    const entries = [
      { projectId: "p1", projectName: "Kozane", isCurrent: true, id: "w1" },
      { projectId: "p1", projectName: "Kozane", isCurrent: true, id: "w2" },
      { projectId: "p2", projectName: "Research", isCurrent: false, id: "w3" },
    ] as WarpListEntry[];

    expect(groupWarpEntries(entries)).toMatchObject([
      {
        projectId: "p1",
        projectName: "Kozane",
        isCurrent: true,
        entries: [{ id: "w1" }, { id: "w2" }],
      },
      { projectId: "p2", projectName: "Research", isCurrent: false, entries: [{ id: "w3" }] },
    ]);
  });

  it("has no groups for an empty list", () => {
    expect(groupWarpEntries([])).toEqual([]);
  });
});

describe("buildWarpDirectory", () => {
  const projects = [
    { id: "p1", name: "Kozane" },
    { id: "p2", name: "Research" },
  ];
  const warps = [warp("w1", 0, 0, "p1"), warp("w2", 100, 100, "p2"), warp("w3", 900, 900, "p2")];
  const cards = [
    { projectId: "p1", ...card(20, 0, "current project card") },
    { projectId: "p2", ...card(120, 100, "research card") },
  ];

  it("leaves out the project being viewed and numbers the rest from one", () => {
    const directory = buildWarpDirectory({ projects, warps, cards, excludeProjectId: "p1" });

    expect(directory).toMatchObject([
      {
        id: "w2",
        projectId: "p2",
        projectName: "Research",
        label: 1,
        hint: "research card",
        isCurrent: false,
      },
      { id: "w3", projectId: "p2", label: 2, hint: null },
    ]);
  });

  it("only hints with cards from the warp's own project", () => {
    const overlapping = [{ projectId: "p1", ...card(100, 100, "wrong project") }];
    const directory = buildWarpDirectory({
      projects,
      warps,
      cards: overlapping,
      excludeProjectId: "p1",
    });

    expect(directory[0]).toMatchObject({ id: "w2", hint: null });
  });

  it("is empty when the workspace has only the project being viewed", () => {
    expect(
      buildWarpDirectory({
        projects: [projects[0]],
        warps,
        cards,
        excludeProjectId: "p1",
      }),
    ).toEqual([]);
  });
});
