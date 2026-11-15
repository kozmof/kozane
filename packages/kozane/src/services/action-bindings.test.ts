import { describe, expect, it, vi } from "vitest";
import {
  ActionBindingError,
  actionBindingPath,
  createActionBindings,
  type ActionBindingMap,
} from "../../../core/src/actions/bindings.js";

const path = (key: string) => actionBindingPath("cards.squash", "source-card", key);
function recording() {
  let next = 0;
  const allocateId = vi.fn(() => `id-${++next}`);
  const now = vi.fn(() => 1_800_000_000);
  return { allocateId, now, bindings: createActionBindings({ mode: "record", allocateId, now }) };
}

describe("action allocation bindings", () => {
  it("allocates each stable path once and keeps entity, child and clock roles distinct", () => {
    const f = recording();
    expect(f.bindings.entityId(path("card"))).toBe("id-1");
    expect(f.bindings.entityId(path("card"))).toBe("id-1");
    expect(f.bindings.childId(path("child"))).toBe("id-2");
    expect(f.bindings.clock(path("created-at"))).toBe(1_800_000_000);
    expect(f.bindings.clock(path("created-at"))).toBe(1_800_000_000);
    expect(f.allocateId).toHaveBeenCalledTimes(2);
    expect(f.now).toHaveBeenCalledOnce();
    expect(() => f.bindings.childId(path("card"))).toThrow(ActionBindingError);
  });

  it("replays after JSON transport in a different query order without allocation sources", () => {
    const f = recording();
    const a = f.bindings.entityId(path("card-a"));
    const b = f.bindings.entityId(path("card-b"));
    const child = f.bindings.childId(path("child-a"));
    const time = f.bindings.clock(path("created-at"));
    const original = f.bindings.snapshot();
    const replay = createActionBindings({
      mode: "replay",
      bindings: JSON.parse(JSON.stringify(original)),
    });
    expect(replay.entityId(path("card-b"))).toBe(b);
    expect(replay.childId(path("child-a"))).toBe(child);
    expect(replay.clock(path("created-at"))).toBe(time);
    expect(replay.entityId(path("card-a"))).toBe(a);
    expect(() => replay.childId(path("card-a"))).toThrow("Binding type changed");
    expect(replay.snapshot()).toEqual(original);
  });

  it("allows skipped branches but refuses every new allocation without changing the map", () => {
    const f = recording();
    f.bindings.entityId(path("skipped"));
    const original = f.bindings.snapshot();
    const replay = createActionBindings({ mode: "replay", bindings: original });
    for (const allocate of [replay.entityId, replay.childId, replay.clock])
      expect(() => allocate(path("new-branch"))).toThrow("Unbound replay allocation");
    expect(replay.snapshot()).toEqual(original);
    expect(f.allocateId).toHaveBeenCalledOnce();
    expect(f.now).not.toHaveBeenCalled();
  });

  it("copies replay bindings and returns immutable independent snapshots", () => {
    const source = { [path("a")]: { type: "entity-id", value: "original" } } as const;
    const replay = createActionBindings({ mode: "replay", bindings: source });
    const snapshot = replay.snapshot();
    Reflect.set(source[path("a")], "value", "changed");
    expect(replay.entityId(path("a"))).toBe("original");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[path("a")])).toBe(true);
    const f = recording();
    const earlier = f.bindings.snapshot();
    f.bindings.entityId(path("b"));
    expect(earlier).toEqual({});
  });

  it.each([
    { type: "entity-id", value: "" },
    { type: "child-id", value: 5 },
    { type: "clock", value: NaN },
    { type: "clock", value: Infinity },
    { type: "clock", value: 1.5 },
    { type: "clock", value: Number.MAX_SAFE_INTEGER + 1 },
    { type: "unknown", value: "id" },
    null,
  ])("refuses malformed recorded bindings %s", (binding) => {
    expect(() =>
      createActionBindings({ mode: "replay", bindings: { a: binding } as ActionBindingMap }),
    ).toThrow(ActionBindingError);
  });

  it("does not retain invalid fresh allocations", () => {
    const bindings = createActionBindings({ mode: "record", allocateId: () => "", now: () => NaN });
    expect(() => bindings.entityId(path("id"))).toThrow("Invalid allocation");
    expect(() => bindings.clock(path("time"))).toThrow("Invalid allocation");
    expect(bindings.snapshot()).toEqual({});
  });

  it("uses collision-free paths and safely stores property-like keys", () => {
    expect(actionBindingPath("cards.create", "a/b", "c")).not.toBe(
      actionBindingPath("cards.create", "a", "b/c"),
    );
    const f = recording();
    const id = f.bindings.entityId("__proto__");
    const replay = createActionBindings({ mode: "replay", bindings: f.bindings.snapshot() });
    expect(replay.entityId("__proto__")).toBe(id);
    expect(() => actionBindingPath("cards.create")).toThrow(ActionBindingError);
    expect(() => actionBindingPath("", "id")).toThrow(ActionBindingError);
    expect(() => actionBindingPath("cards.create", "")).toThrow(ActionBindingError);
    expect(() => f.bindings.entityId("")).toThrow(ActionBindingError);
  });
});
