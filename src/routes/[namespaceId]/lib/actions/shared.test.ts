import { describe, expect, it } from "vitest";
import type { CardWithGlue } from "$lib/types";
import { fieldSnapshot, restoreField } from "../../../../lib/client/board/lib/actions/shared.js";

function card(id: string, partitionId: string): CardWithGlue {
  return {
    id,
    content: id,
    partitionId,
    layerId: "layer",
    posX: 0,
    posY: 0,
    taskspaceId: null,
    zIndex: 0,
    width: null,
    inventory: null,
    glueId: null,
  };
}

describe("restoreField", () => {
  it("restores cards that still hold the failed change's value", () => {
    const before = [card("a", "p1"), card("b", "p1")];
    const previous = fieldSnapshot(before, ["a", "b"], "partitionId");
    const optimistic = before.map((c) => ({ ...c, partitionId: "p2" }));

    const restored = restoreField(optimistic, "partitionId", previous, "p2");

    expect(restored.map((c) => c.partitionId)).toEqual(["p1", "p1"]);
  });

  it("keeps a later change made while the failed request was in flight", () => {
    const before = [card("a", "p1"), card("b", "p1")];
    const previous = fieldSnapshot(before, ["a", "b"], "partitionId");
    // The failed request moved both cards to p2, then a second change moved `a` on to p3.
    const current = [card("a", "p3"), card("b", "p2")];

    const restored = restoreField(current, "partitionId", previous, "p2");

    expect(restored.map((c) => c.partitionId)).toEqual(["p3", "p1"]);
  });

  it("leaves cards outside the snapshot alone", () => {
    const previous = fieldSnapshot([card("a", "p1")], ["a"], "partitionId");
    const current = [card("a", "p2"), card("c", "p2")];

    const restored = restoreField(current, "partitionId", previous, "p2");

    expect(restored.map((c) => c.partitionId)).toEqual(["p1", "p2"]);
  });
});

describe("rollback field types", () => {
  it("refuse object fields, which `===` could never match after a copy", () => {
    // @ts-expect-error `inventory` holds an object.
    void (() => fieldSnapshot([], [], "inventory"));
    expect(fieldSnapshot([], [], "layerId").size).toBe(0);
  });
});
