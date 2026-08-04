import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ProjectPage from "./+page.svelte";

const data = {
  project: { id: "project-1", name: "Project", isDefault: true },
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
    defaultCardWidth: 210,
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
  readonly: false,
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

  it("keeps a dragged card in place when an older snapshot finishes", async () => {
    let resolveSnapshot!: (response: { ok: boolean; json: () => Promise<typeof data> }) => void;
    const snapshotResponse = new Promise<{ ok: boolean; json: () => Promise<typeof data> }>(
      (resolve) => (resolveSnapshot = resolve),
    );
    const snapshotJson = vi.fn(async () => data);
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => snapshotResponse)
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);

    render(ProjectPage, {
      props: {
        data,
        params: { projectId: "project-1" },
        form: null,
      },
    });

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const card = screen.getByRole("button", { name: "Card: Alpha" });
    await fireEvent.mouseDown(card, { button: 0, clientX: 30, clientY: 60 });
    await fireEvent.mouseMove(window, { clientX: 222, clientY: 180 });
    expect(card).toHaveStyle({ left: "216px", top: "168px" });

    resolveSnapshot({ ok: true, json: snapshotJson });
    await waitFor(() => expect(snapshotJson).toHaveBeenCalledOnce());
    expect(card).toHaveStyle({ left: "216px", top: "168px" });

    await fireEvent.mouseUp(window);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
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
    expect(screen.queryByLabelText("Write a card")).not.toBeInTheDocument();

    await fireEvent.keyDown(window, { key: "i" });
    expect(screen.queryByLabelText("Write a card")).not.toBeInTheDocument();

    await fireEvent.keyDown(window, { key: "z" });
    const input = screen.getByLabelText("Write a card");
    await waitFor(() => expect(input).toHaveFocus());

    await fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input).not.toHaveFocus());
  });

  it("hides all editing affordances in read-only mode", async () => {
    const { container } = render(ProjectPage, {
      props: {
        data: { ...data, readonly: true },
        params: { projectId: "project-1" },
        form: null,
      },
    });

    // Bundle filtering still works — the read-only export is for browsing.
    expect(screen.getByText("All cards")).toBeInTheDocument();

    // The composer, the create-bundle/scope inputs, and the working-copy input
    // are all gone, so there is no text entry anywhere on the page.
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(screen.queryByLabelText("Write a card")).not.toBeInTheDocument();

    // The focus-composer shortcut is disabled and must not resurrect the composer.
    await fireEvent.keyDown(window, { key: "z" });
    expect(screen.queryByLabelText("Write a card")).not.toBeInTheDocument();
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
