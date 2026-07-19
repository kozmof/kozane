import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ProjectPage from "./+page.svelte";

const data = {
  project: { id: "project-1", name: "Project" },
  bundles: [
    { id: "b1", projectId: "project-1", name: "General", isDefault: true },
    { id: "b2", projectId: "project-1", name: "Research", isDefault: false },
  ],
  cards: [
    {
      id: "card-1",
      bundleId: "b1",
      content: "Alpha",
      posX: 24,
      posY: 48,
      glueId: null,
      workingCopyId: null,
    },
    {
      id: "card-2",
      bundleId: "b1",
      content: "Beta",
      posX: 96,
      posY: 48,
      glueId: null,
      workingCopyId: null,
    },
  ],
  scopes: [{ id: "scope-1", name: "Now" }],
  scopeRels: [],
  glueRels: [],
  workingCopies: [],
  otherProjects: [],
  uiConfig: {
    defaultFontSize: 11.5,
    defaultFontFamily: "monospace",
    defaultCardWidth: 240,
    defaultZoom: 1,
    leftPanelWidth: 216,
    rightPanelWidth: 232,
    defaultShowFooter: true,
    defaultShowSidePanel: true,
    toggleFootersShortcut: "x",
    togglePanelsShortcut: "y",
    focusCardInputShortcut: "z",
    clearSelectionShortcut: "Escape",
    copyCardIdShortcut: "c",
    bringCardToFrontShortcut: "]",
    sendCardToBackShortcut: "[",
    glueCardsShortcut: "g",
    unglueCardShortcut: "u",
    moveCardsShortcut: "m",
    deleteCardsShortcut: "Delete",
    canvasWidth: 2800,
    canvasHeight: 2000,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Project page", () => {
  it("uses the configured shortcuts to toggle footers and panels", async () => {
    const { container } = render(ProjectPage, {
      props: {
        data,
        params: { projectId: "project-1" },
        form: null,
      },
    });

    const footer = container.querySelector<HTMLElement>("[style*=\x27visibility\x27]");
    const panels = container.querySelectorAll<HTMLElement>("aside");
    expect(footer).toHaveStyle({ visibility: "visible" });

    await fireEvent.keyDown(window, { key: "f" });
    expect(footer).toHaveStyle({ visibility: "visible" });

    await fireEvent.keyDown(window, { key: "x" });
    expect(footer).toHaveStyle({ visibility: "hidden" });

    await fireEvent.keyDown(window, { key: "y" });
    expect([...panels].every((panel) => panel.style.width === "0px")).toBe(true);
  });

  it("uses the configured shortcut to focus the create-card input", async () => {
    render(ProjectPage, {
      props: {
        data,
        params: { projectId: "project-1" },
        form: null,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    expect(screen.queryByPlaceholderText("Write a card")).not.toBeInTheDocument();

    await fireEvent.keyDown(window, { key: "i" });
    expect(screen.queryByPlaceholderText("Write a card")).not.toBeInTheDocument();

    await fireEvent.keyDown(window, { key: "z" });
    await waitFor(() => expect(screen.getByPlaceholderText("Write a card")).toHaveFocus());
  });

  it("glues selected cards through the composed board UI", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ glueId: "glue-1" }),
    });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: {
        data,
        params: { projectId: "project-1" },
        form: null,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.click(screen.getByRole("button", { name: "Card: Beta" }), {
      shiftKey: true,
    });
    await fireEvent.click(screen.getByRole("button", { name: /Glue/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/glues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["card-1", "card-2"] }),
    });
    expect(screen.getByRole("button", { name: /Unglue all/ })).toBeInTheDocument();
  });
});
