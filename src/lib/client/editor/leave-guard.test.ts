import { describe, expect, it, vi } from "vitest";
import { guardUnsavedLeave } from "./leave-guard";

function intent(type: string) {
  return { type, cancel: vi.fn() };
}

describe("guardUnsavedLeave", () => {
  it("lets a saved file go without asking", () => {
    const nav = intent("link");
    const ask = vi.fn(() => true);
    expect(guardUnsavedLeave(nav, false, ask)).toBe(false);
    expect(nav.cancel).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("cancels a tab closing on an unsaved file, leaving the browser to ask", () => {
    const nav = intent("leave");
    const ask = vi.fn(() => true);
    expect(guardUnsavedLeave(nav, true, ask)).toBe(true);
    expect(nav.cancel).toHaveBeenCalledOnce();
    // The browser's dialog is the only one available here, so there is nothing to ask.
    expect(ask).not.toHaveBeenCalled();
  });

  it("stops an in-app navigation the answer refused", () => {
    const nav = intent("link");
    expect(guardUnsavedLeave(nav, true, () => false)).toBe(true);
    expect(nav.cancel).toHaveBeenCalledOnce();
  });

  it("lets an in-app navigation through once it is confirmed", () => {
    const nav = intent("link");
    expect(guardUnsavedLeave(nav, true, () => true)).toBe(false);
    expect(nav.cancel).not.toHaveBeenCalled();
  });

  it("asks about the back button and a warp's goto alike", () => {
    for (const type of ["popstate", "goto", "form"]) {
      const nav = intent(type);
      const ask = vi.fn(() => false);
      guardUnsavedLeave(nav, true, ask);
      expect(ask, type).toHaveBeenCalledOnce();
      expect(nav.cancel, type).toHaveBeenCalledOnce();
    }
  });
});
