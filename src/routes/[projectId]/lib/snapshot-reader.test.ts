import { describe, expect, it } from "vitest";
import type { ProjectDataSnapshot } from "$lib/types.js";
import { readProjectSnapshot } from "./snapshot-reader.js";

/** A board with one of everything, which is what the endpoint actually answers with. */
function fullSnapshot(): ProjectDataSnapshot {
  return {
    project: { id: "p1" },
    cards: [
      {
        id: "c1",
        bundleId: "b1",
        layerId: "l1",
        content: "hello",
        posX: 10,
        posY: 20,
        zIndex: 3,
        taskspaceId: null,
        glueId: null,
        width: null,
      },
    ],
    bundles: [{ id: "b1", projectId: "p1", name: "General", isDefault: true }],
    layers: [{ id: "l1", projectId: "p1", name: "Base", position: 0, isDefault: true }],
    warps: [{ id: "w1", projectId: "p1", posX: 100, posY: 200 }],
    scopes: [{ id: "s1", name: "Draft" }],
    scopeRels: [{ scopeId: "s1", cardId: "c1" }],
    glueRels: [{ glueId: "g1", cardId: "c1" }],
    taskspaces: [
      { id: "t1", name: "draft", scopeId: "s1", path: "draft", pathKind: "project_relative" },
    ],
  };
}

/** Round-trips through JSON, as a real response does. */
function read(value: unknown): ProjectDataSnapshot | undefined {
  return readProjectSnapshot(JSON.parse(JSON.stringify(value)));
}

describe("readProjectSnapshot", () => {
  it("reads a whole snapshot back unchanged", () => {
    const snapshot = fullSnapshot();
    expect(read(snapshot)).toEqual(snapshot);
  });

  it("accepts the nulls that are values rather than omissions", () => {
    const snapshot = fullSnapshot();
    snapshot.cards[0].taskspaceId = null;
    snapshot.cards[0].glueId = null;
    snapshot.cards[0].width = null;
    // A static export strips taskspace paths; an unplaced taskspace has no scope.
    snapshot.taskspaces[0].path = null;
    snapshot.taskspaces[0].scopeId = null;
    expect(read(snapshot)).toEqual(snapshot);
  });

  it("accepts an empty card, which the board draws as one", () => {
    const snapshot = fullSnapshot();
    snapshot.cards[0].content = "";
    expect(read(snapshot)?.cards[0].content).toBe("");
  });

  it("accepts a board with nothing on it", () => {
    const empty: ProjectDataSnapshot = {
      project: { id: "p1" },
      cards: [],
      bundles: [],
      layers: [],
      warps: [],
      scopes: [],
      scopeRels: [],
      glueRels: [],
      taskspaces: [],
    };
    expect(read(empty)).toEqual(empty);
  });

  it.each([
    ["not an object", "a string"],
    ["null", null],
    ["an array", []],
    ["no project", { cards: [] }],
  ])("refuses %s", (_label, value) => {
    expect(read(value)).toBeUndefined();
  });

  it.each(["cards", "bundles", "layers", "warps", "scopes", "scopeRels", "glueRels", "taskspaces"])(
    "refuses a snapshot missing %s",
    (key) => {
      const snapshot: Record<string, unknown> = { ...fullSnapshot() };
      delete snapshot[key];
      expect(read(snapshot)).toBeUndefined();
    },
  );

  it("refuses a card with a non-finite position", () => {
    const snapshot = fullSnapshot();
    // NaN travels through JSON as null, which is how one reaches the client at all.
    const wire = JSON.parse(JSON.stringify(snapshot));
    wire.cards[0].posX = null;
    expect(readProjectSnapshot(wire)).toBeUndefined();
  });

  it("refuses a card missing its bundle", () => {
    const snapshot: ProjectDataSnapshot = fullSnapshot();
    const wire = JSON.parse(JSON.stringify(snapshot));
    delete wire.cards[0].bundleId;
    expect(readProjectSnapshot(wire)).toBeUndefined();
  });

  it("refuses an unknown path kind", () => {
    const wire = JSON.parse(JSON.stringify(fullSnapshot()));
    wire.taskspaces[0].pathKind = "somewhere_else";
    expect(readProjectSnapshot(wire)).toBeUndefined();
  });

  it("refuses the whole list when one row of it is bad", () => {
    const snapshot = fullSnapshot();
    const wire = JSON.parse(JSON.stringify(snapshot));
    wire.bundles.push({ id: "b2", projectId: "p1", name: "Other" }); // no isDefault
    expect(readProjectSnapshot(wire)).toBeUndefined();
  });

  it("refuses a width that is neither a number nor null", () => {
    const wire = JSON.parse(JSON.stringify(fullSnapshot()));
    wire.cards[0].width = "220";
    expect(readProjectSnapshot(wire)).toBeUndefined();
  });
});
