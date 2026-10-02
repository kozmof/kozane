import { describe, expect, it, vi } from "vitest";
import {
  bindingsByKey,
  hasCommandModifier,
  isTypingTarget,
  runKeyBindings,
  type BoardKeyEvent,
  type KeyBinding,
} from "./board-keymap.js";

function keyEvent(key: string, shiftKey = false): BoardKeyEvent & { prevented: boolean } {
  const event = {
    key,
    shiftKey,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
}

/** A binding that records being run, which is all most of these cases need to observe. */
function spyBinding(name: string, overrides: Partial<KeyBinding> = {}): KeyBinding {
  return { name, keys: [name], run: vi.fn(), ...overrides };
}

describe("runKeyBindings", () => {
  it("runs the binding that claims the key and reports having done so", () => {
    const binding = spyBinding("f");
    expect(runKeyBindings(keyEvent("f"), [binding])).toBe(true);
    expect(binding.run).toHaveBeenCalledOnce();
  });

  it("reports no match for a key nothing claims, and runs nothing", () => {
    const binding = spyBinding("f");
    expect(runKeyBindings(keyEvent("q"), [binding])).toBe(false);
    expect(binding.run).not.toHaveBeenCalled();
  });

  it("runs only the first of two bindings on one key", () => {
    // The property the `if` chain this replaces held by giving every branch a `return`, and
    // the one `validateUiOverrides` warns about: a config binding two actions to one key
    // gets the earlier action, and the later one is unreachable.
    const first = spyBinding("footers", { keys: ["f"] });
    const second = spyBinding("panels", { keys: ["f"] });
    runKeyBindings(keyEvent("f"), [first, second]);
    expect(first.run).toHaveBeenCalledOnce();
    expect(second.run).not.toHaveBeenCalled();
  });

  it("passes over a binding whose condition does not hold rather than ending the dispatch", () => {
    // A read-only export is the case: the focus-composer binding stands down, and a toggle
    // sharing its key must still fire.
    const blocked = spyBinding("focus composer", { keys: ["f"], when: () => false });
    const fallback = spyBinding("toggle footers", { keys: ["f"] });
    expect(runKeyBindings(keyEvent("f"), [blocked, fallback])).toBe(true);
    expect(blocked.run).not.toHaveBeenCalled();
    expect(fallback.run).toHaveBeenCalledOnce();
  });

  it("matches a binding that requires Shift only when Shift is held", () => {
    const binding = spyBinding("open palette", { keys: ["ArrowUp"], shift: true });
    expect(runKeyBindings(keyEvent("ArrowUp", false), [binding])).toBe(false);
    expect(runKeyBindings(keyEvent("ArrowUp", true), [binding])).toBe(true);
    expect(binding.run).toHaveBeenCalledOnce();
  });

  it("matches a binding that refuses Shift only when Shift is absent", () => {
    const binding = spyBinding("warp", { keys: ["ArrowUp"], shift: false });
    expect(runKeyBindings(keyEvent("ArrowUp", true), [binding])).toBe(false);
    expect(runKeyBindings(keyEvent("ArrowUp", false), [binding])).toBe(true);
  });

  it("sends Shift and unshifted arrows to different bindings", () => {
    const palette = spyBinding("open palette", { keys: ["ArrowUp"], shift: true });
    const warp = spyBinding("warp", { keys: ["ArrowUp"], shift: false });
    runKeyBindings(keyEvent("ArrowUp", true), [palette, warp]);
    expect(palette.run).toHaveBeenCalledOnce();
    expect(warp.run).not.toHaveBeenCalled();
  });

  it("ignores Shift for a binding that does not mention it", () => {
    // How every letter shortcut behaves: `toggleWarpsShortcut` is `A`, which already
    // arrives as a capital, so the binding matches by key alone.
    const binding = spyBinding("toggle warps", { keys: ["A"] });
    expect(runKeyBindings(keyEvent("A", true), [binding])).toBe(true);
  });

  it("cancels the key before running when the binding declares it", () => {
    const event = keyEvent("i");
    runKeyBindings(event, [spyBinding("focus composer", { keys: ["i"], preventDefault: true })]);
    expect(event.prevented).toBe(true);
  });

  it("leaves the key alone for a binding that does not declare it", () => {
    const event = keyEvent("f");
    runKeyBindings(event, [spyBinding("toggle footers", { keys: ["f"] })]);
    expect(event.prevented).toBe(false);
  });

  it("lets a binding cancel the key itself", () => {
    // Warp navigation does this: it cancels only once it has found somewhere to go, so
    // arrowing past the last warp leaves the key to the browser.
    const event = keyEvent("ArrowUp");
    runKeyBindings(event, [{ name: "warp", keys: ["ArrowUp"], run: (e) => e.preventDefault() }]);
    expect(event.prevented).toBe(true);
  });

  it("does not cancel the key for a binding it passed over", () => {
    const event = keyEvent("Escape");
    const skipped: KeyBinding = {
      name: "dismiss frame",
      keys: ["Escape"],
      when: () => false,
      preventDefault: true,
      run: vi.fn(),
    };
    expect(runKeyBindings(event, [skipped])).toBe(false);
    expect(event.prevented).toBe(false);
  });

  it("runs one binding for any of the keys it lists", () => {
    const binding = spyBinding("warp", { keys: ["ArrowLeft", "ArrowRight"] });
    runKeyBindings(keyEvent("ArrowLeft"), [binding]);
    runKeyBindings(keyEvent("ArrowRight"), [binding]);
    expect(binding.run).toHaveBeenCalledTimes(2);
  });

  it("hands the event to the binding, so a key family can read which key arrived", () => {
    const seen: string[] = [];
    const binding: KeyBinding = {
      name: "warp",
      keys: ["ArrowLeft", "ArrowDown"],
      run: (e) => seen.push(e.key),
    };
    runKeyBindings(keyEvent("ArrowDown"), [binding]);
    expect(seen).toEqual(["ArrowDown"]);
  });

  it("asks `when` only of a binding whose key matched", () => {
    const when = vi.fn(() => true);
    runKeyBindings(keyEvent("q"), [spyBinding("f", { keys: ["f"], when })]);
    expect(when).not.toHaveBeenCalled();
  });

  it("runs nothing for an empty table", () => {
    expect(runKeyBindings(keyEvent("f"), [])).toBe(false);
  });
});

describe("bindingsByKey", () => {
  it("lists the bindings claiming a key in the order the dispatcher reaches them", () => {
    const claims = bindingsByKey([
      { name: "toggle footers", keys: ["f"], run: () => {} },
      { name: "toggle panels", keys: ["f"], run: () => {} },
    ]);
    expect(claims.get("f")).toEqual(["toggle footers", "toggle panels"]);
  });

  it("keeps a key family's entries apart", () => {
    const claims = bindingsByKey([{ name: "warp", keys: ["ArrowUp", "ArrowDown"], run: () => {} }]);
    expect(claims.get("ArrowUp")).toEqual(["warp"]);
    expect(claims.get("ArrowDown")).toEqual(["warp"]);
  });

  it("does not count a Shift binding and a non-Shift one as competing", () => {
    const claims = bindingsByKey([
      { name: "open palette", keys: ["ArrowUp"], shift: true, run: () => {} },
      { name: "warp", keys: ["ArrowUp"], shift: false, run: () => {} },
    ]);
    expect(claims.get("Shift+ArrowUp")).toEqual(["open palette"]);
    expect(claims.get("!Shift+ArrowUp")).toEqual(["warp"]);
  });
});

describe("isTypingTarget", () => {
  it("is false for nothing at all", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it("is true for an input and a textarea", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
  });

  it("is true for an element that takes text without being either", () => {
    const element = document.createElement("div");
    element.contentEditable = "true";
    // jsdom does not derive `isContentEditable` from the attribute, so it is set directly:
    // the property is what the guard reads, and what a browser would have set here.
    Object.defineProperty(element, "isContentEditable", { value: true });
    expect(isTypingTarget(element)).toBe(true);
  });

  it("is false for an ordinary element", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
  });
});

describe("hasCommandModifier", () => {
  const none = { ctrlKey: false, metaKey: false, altKey: false };

  it("is false for an unmodified key", () => {
    expect(hasCommandModifier(none)).toBe(false);
  });

  it("is true for Ctrl, Meta and Alt", () => {
    expect(hasCommandModifier({ ...none, ctrlKey: true })).toBe(true);
    expect(hasCommandModifier({ ...none, metaKey: true })).toBe(true);
    expect(hasCommandModifier({ ...none, altKey: true })).toBe(true);
  });

  it("does not treat Shift as one, since a shortcut may be a capital letter", () => {
    expect(hasCommandModifier({ ...none })).toBe(false);
  });
});
