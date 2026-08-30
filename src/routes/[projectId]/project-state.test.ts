import { describe, it, expect, beforeEach } from "vitest";
import {
  ProjectState,
  resolveActiveLayerId,
  readStoredLayerId,
  storeActiveLayerId,
} from "./project-state.svelte.js";
import { nodeKey } from "./lib/taskspace-tree.svelte.js";
import type {
  Bundle,
  CardWithGlue,
  Layer,
  ProjectDataSnapshot,
  Scope,
  TaskspaceSummary,
  Warp,
} from "$lib/types";

const layer = (id: string, isDefault = false): Layer => ({
  id,
  projectId: "p1",
  name: id,
  position: 0,
  isDefault,
});

const bundle = (id: string): Bundle => ({ id, projectId: "p1", name: id, isDefault: false });

const scope = (id: string): Scope => ({ id, name: id });

const warp = (id: string): Warp => ({ id, projectId: "p1", posX: 0, posY: 0 });

const taskspace = (id: string): TaskspaceSummary => ({
  id,
  name: id,
  scopeId: null,
  path: null,
  pathKind: "project_relative",
});

const card = (id: string, overrides: Partial<CardWithGlue> = {}): CardWithGlue => ({
  id,
  bundleId: "b1",
  layerId: "l1",
  content: id,
  posX: 0,
  posY: 0,
  zIndex: 0,
  glueId: null,
  taskspaceId: null,
  width: null,
  ...overrides,
});

function snapshot(overrides: Partial<ProjectDataSnapshot> = {}): ProjectDataSnapshot {
  return {
    project: { id: "p1" },
    cards: [],
    bundles: [],
    layers: [layer("l1", true)],
    warps: [],
    scopes: [],
    scopeRels: [],
    glueRels: [],
    taskspaces: [],
    ...overrides,
  };
}

beforeEach(() => sessionStorage.clear());

describe("resolveActiveLayerId", () => {
  it("keeps a preferred layer the project still has", () => {
    expect(resolveActiveLayerId([layer("l1", true), layer("l2")], "l2")).toBe("l2");
  });

  it("falls back to the default layer when the preferred one is gone", () => {
    expect(resolveActiveLayerId([layer("l1"), layer("l2", true)], "gone")).toBe("l2");
  });

  it("falls back to the first layer when no layer is the default", () => {
    expect(resolveActiveLayerId([layer("l1"), layer("l2")], null)).toBe("l1");
  });

  it("answers null for a project with no layers at all", () => {
    expect(resolveActiveLayerId([], "l1")).toBeNull();
  });
});

describe("stored layer preference", () => {
  it("round-trips a layer per project", () => {
    storeActiveLayerId("p1", "l2");
    storeActiveLayerId("p2", "l9");
    expect(readStoredLayerId("p1")).toBe("l2");
    expect(readStoredLayerId("p2")).toBe("l9");
  });

  it("answers null for a project nothing was stored for", () => {
    expect(readStoredLayerId("never-seen")).toBeNull();
  });

  it("clears the entry when handed null", () => {
    storeActiveLayerId("p1", "l2");
    storeActiveLayerId("p1", null);
    expect(readStoredLayerId("p1")).toBeNull();
  });

  // Storage is absent while prerendering and throws outright in a browser with site data
  // blocked. A lost preference is not worth an error, so both reads and writes swallow it.
  it("survives storage that throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => storeActiveLayerId("p1", "l2")).not.toThrow();
      expect(readStoredLayerId("p1")).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    }
  });
});

describe("ProjectState.resetFromData", () => {
  it("takes the whole board and clears everything the last one left behind", () => {
    const state = new ProjectState();
    state.selection.selectedCards = new Set(["old"]);
    state.selection.primarySelectedId = "old";
    state.sidebar.activeBundle = "old-bundle";
    state.focusedWarpId = "old-warp";
    state.lastError = "something went wrong";

    state.resetFromData(snapshot({ cards: [card("c1")], bundles: [bundle("b1")] }));

    expect(state.projectId).toBe("p1");
    expect(state.cards.map(({ id }) => id)).toEqual(["c1"]);
    expect(state.selection.selectedCards).toEqual(new Set());
    expect(state.selection.primarySelectedId).toBeNull();
    expect(state.sidebar.activeBundle).toBeNull();
    expect(state.focusedWarpId).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it("restores the layer this project was last worked on", () => {
    storeActiveLayerId("p1", "l2");
    const state = new ProjectState();

    state.resetFromData(snapshot({ layers: [layer("l1", true), layer("l2")] }));

    expect(state.activeLayerId).toBe("l2");
  });
});

/**
 * The invariants that keep the board's own selections pointing at rows the snapshot still
 * has. Every one of them is about a write made somewhere else — the CLI, or another tab —
 * arriving on a board that had picked something out, so each is checked on its own rather
 * than through the page that happens to hold them all.
 */
describe("ProjectState.refreshFromData", () => {
  function board(): ProjectState {
    const state = new ProjectState();
    state.resetFromData(
      snapshot({
        cards: [card("c1"), card("c2")],
        bundles: [bundle("b1"), bundle("b2")],
        layers: [layer("l1", true), layer("l2")],
        warps: [warp("w1")],
        scopes: [scope("s1")],
        taskspaces: [taskspace("t1")],
      }),
    );
    return state;
  }

  it("drops a selected card the snapshot no longer has, and keeps the rest", () => {
    const state = board();
    state.selection.selectedCards = new Set(["c1", "c2"]);

    state.refreshFromData(snapshot({ cards: [card("c2")] }));

    expect(state.selection.selectedCards).toEqual(new Set(["c2"]));
  });

  it("clears the primary selection when its card is gone", () => {
    const state = board();
    state.selection.primarySelectedId = "c1";

    state.refreshFromData(snapshot({ cards: [card("c2")] }));

    expect(state.selection.primarySelectedId).toBeNull();
  });

  it("closes the composer when the card it was editing is gone", () => {
    const state = board();
    state.selection.composerCard = card("c1");

    state.refreshFromData(snapshot({ cards: [card("c2")] }));

    expect(state.selection.composerCard).toBeNull();
  });

  // The composer edits a card, so it must follow that card's text when it is rewritten
  // elsewhere rather than hold the copy it opened with.
  it("re-points the composer at the incoming copy of the card it holds", () => {
    const state = board();
    state.selection.composerCard = card("c1", { content: "old" });

    state.refreshFromData(snapshot({ cards: [card("c1", { content: "rewritten" })] }));

    expect(state.selection.composerCard).toMatchObject({ id: "c1", content: "rewritten" });
  });

  it("moves off a layer deleted elsewhere, onto the default one", () => {
    const state = board();
    state.activeLayerId = "l2";

    state.refreshFromData(snapshot({ layers: [layer("l1", true)] }));

    expect(state.activeLayerId).toBe("l1");
  });

  it("unfocuses a warp deleted elsewhere", () => {
    const state = board();
    state.focusedWarpId = "w1";

    state.refreshFromData(snapshot({ warps: [] }));

    expect(state.focusedWarpId).toBeNull();
  });

  it("keeps the focused warp when it is still there", () => {
    const state = board();
    state.focusedWarpId = "w1";

    state.refreshFromData(snapshot({ warps: [warp("w1")] }));

    expect(state.focusedWarpId).toBe("w1");
  });

  it("clears the active bundle filter when its bundle is gone", () => {
    const state = board();
    state.sidebar.activeBundle = "b2";

    state.refreshFromData(snapshot({ bundles: [bundle("b1")] }));

    expect(state.sidebar.activeBundle).toBeNull();
  });

  // A scope can leave `data.scopes` without being deleted: the list is narrowed to the ones
  // this project draws, so an unattached scope another project has since claimed simply
  // stops arriving. Either way it must not stay the active filter.
  it("clears the active scope filter when its scope stops arriving", () => {
    const state = board();
    state.sidebar.activeScope = "s1";

    state.refreshFromData(snapshot({ scopes: [] }));

    expect(state.sidebar.activeScope).toBeNull();
  });

  it("prunes cached directory rows for a taskspace that is gone", () => {
    const state = board();
    state.taskspaceTree.expanded = new Set([nodeKey("t1", ""), nodeKey("t2", "")]);

    state.refreshFromData(snapshot({ taskspaces: [taskspace("t2")] }));

    expect(state.taskspaceTree.expanded).toEqual(new Set([nodeKey("t2", "")]));
  });

  // Unlike `resetFromData`, this is the same board being brought up to date — a selection
  // whose rows all survived is the user's, and a poll must not clear it.
  it("leaves a selection whose cards all survived alone", () => {
    const state = board();
    state.selection.selectedCards = new Set(["c1", "c2"]);
    state.selection.primarySelectedId = "c1";

    state.refreshFromData(snapshot({ cards: [card("c1"), card("c2")] }));

    expect(state.selection.selectedCards).toEqual(new Set(["c1", "c2"]));
    expect(state.selection.primarySelectedId).toBe("c1");
  });
});
