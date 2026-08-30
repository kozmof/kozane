import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import ScopeControl from "./ScopeControl.svelte";

const SCOPES = [
  { id: "scope-1", name: "My Scope" },
  { id: "scope-2", name: "Other Scope" },
];

function mount(overrides: Record<string, unknown> = {}) {
  render(ScopeControl, {
    props: { scopes: SCOPES, activeScope: null, ...overrides },
  });
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { expanded: false, hidden: false });
}

describe("ScopeControl", () => {
  // A board with no scopes has nothing to focus and nothing to escape, so the control does
  // not take a slot in the corner it would otherwise share with layers and panels.
  it("renders nothing at all when the project has no scopes", () => {
    mount({ scopes: [] });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the scopes once one exists", async () => {
    mount();
    expect(screen.queryByRole("listbox")).toBeNull();

    await userEvent.click(screen.getByLabelText("Focus a scope"));

    expect(screen.getByRole("listbox", { name: "Scopes" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /My Scope/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Other Scope/ })).toBeTruthy();
  });

  it("focuses the scope that was picked and closes", async () => {
    mount();
    await userEvent.click(screen.getByLabelText("Focus a scope"));
    await userEvent.click(screen.getByRole("option", { name: /My Scope/ }));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("Focused on scope My Scope")).toBeTruthy();
  });

  // The way back out. A board can sit under a scope indefinitely, so escaping has to be
  // reachable from the same control that entered it.
  it("escapes the focus through No scope", async () => {
    mount({ activeScope: "scope-1" });
    expect(screen.getByLabelText("Focused on scope My Scope")).toBeTruthy();

    await userEvent.click(screen.getByLabelText("Focused on scope My Scope"));
    await userEvent.click(screen.getByRole("option", { name: /No scope/ }));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("Focus a scope")).toBeTruthy();
  });

  it("marks the focused scope as the selected option, and No scope otherwise", async () => {
    mount({ activeScope: "scope-2" });
    await userEvent.click(screen.getByLabelText("Focused on scope Other Scope"));

    expect(screen.getByRole("option", { name: /Other Scope/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("option", { name: /No scope/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(screen.getByRole("option", { name: /My Scope/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  // The eye is the state, the same glyph the side panel's focused row carries. Resting, it
  // is the same eye drawn shut — a bare lid, with no pupil to look with.
  it("draws a closed eye while nothing is focused", () => {
    mount();
    expect(trigger().querySelector("svg circle")).toBeNull();
  });

  it("opens the eye on the trigger when a scope is already focused", () => {
    mount({ activeScope: "scope-1" });
    expect(trigger().querySelector("svg circle")).toBeTruthy();
  });

  // Escape closes the menu without leaving the scope: the board stays where it was put, and
  // "No scope" remains the one way to actually let go of it.
  it("closes on Escape but keeps the board under its scope", async () => {
    mount({ activeScope: "scope-1" });
    await userEvent.click(screen.getByLabelText("Focused on scope My Scope"));
    expect(screen.getByRole("listbox")).toBeTruthy();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("Focused on scope My Scope")).toBeTruthy();
  });
});
