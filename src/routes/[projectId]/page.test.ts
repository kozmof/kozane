import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ProjectPage from "./+page.svelte";

const data = {
  project: { id: "project-1", name: "Project", isDefault: true },
  bundles: [
    { id: "b1", projectId: "project-1", name: "General", isDefault: true },
    { id: "b2", projectId: "project-1", name: "Research", isDefault: false },
  ],
  layers: [
    { id: "l1", projectId: "project-1", name: "Base", position: 0, isDefault: true },
    { id: "l2", projectId: "project-1", name: "Draft", position: 1, isDefault: false },
  ],
  cards: [
    {
      id: "card-1",
      bundleId: "b1",
      layerId: "l1",
      content: "Alpha",
      posX: 24,
      posY: 48,
      zIndex: 0,
      glueId: null,
      taskspaceId: null,
    },
    {
      id: "card-2",
      bundleId: "b1",
      layerId: "l1",
      content: "Beta",
      posX: 96,
      posY: 48,
      zIndex: 0,
      glueId: null,
      taskspaceId: null,
    },
  ],
  scopes: [{ id: "scope-1", name: "Now" }],
  scopeRels: [],
  glueRels: [],
  taskspaces: [],
  otherProjects: [],
  uiConfig: {
    defaultFontSize: 11.5,
    defaultFontFamily: "monospace",
    defaultCardWidth: 210,
    newCardPlacement: "grid" as const,
    defaultZoom: 1,
    zoomStep: 0.05,
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
  it("uses the configured zoom step", async () => {
    const { container } = render(ProjectPage, {
      props: {
        data: { ...data, uiConfig: { ...data.uiConfig, zoomStep: 0.05 } },
        params: { projectId: "project-1" },
        form: null,
      },
    });

    expect(screen.getByText("100%")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("105%")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("100%")).toBeInTheDocument();

    const canvas = container.querySelector<HTMLElement>('[role="presentation"]')!;
    await fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -1 });
    expect(screen.getByText("105%")).toBeInTheDocument();
  });

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

    // The composer, the create-bundle/scope inputs, and the taskspace input
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Unglue all/ })).toBeInTheDocument(),
    );
  });
});

describe("Layers", () => {
  function layerGroup(container: HTMLElement, layerId: string): HTMLElement {
    return container.querySelector<HTMLElement>(`[data-layer-id="${layerId}"]`)!;
  }

  it("stacks the active layer on top and dims the others", () => {
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    // "Base" is the default layer, so it starts active: full opacity and the top rank.
    expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "1", "z-index": "1" });
    expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "0.3", "z-index": "0" });
  });

  it("restacks when another layer is selected from the hover popover", async () => {
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(screen.getByRole("option", { name: /Draft/ }));

    expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "1", "z-index": "1" });
    expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "0.3", "z-index": "0" });
  });

  it("keeps cards on dimmed layers clickable", async () => {
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(screen.getByRole("option", { name: /Draft/ }));

    // The wrapper lets events through; the card itself still receives them.
    expect(layerGroup(container, "l1")).toHaveStyle({ "pointer-events": "none" });
    const card = screen.getByRole("button", { name: "Card: Alpha" });
    expect(card).toHaveStyle({ "pointer-events": "auto" });
    await fireEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "true");
  });

  it("creates a card on the selected layer", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "card-3",
        bundleId: "b1",
        layerId: "l2",
        content: "Gamma",
        posX: 0,
        posY: 0,
        zIndex: 1,
        glueId: null,
        taskspaceId: null,
      }),
    });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(screen.getByRole("option", { name: /Draft/ }));

    const input = screen.getByLabelText("Write a card");
    await fireEvent.input(input, { target: { value: "Gamma" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/project-1/api/cards");
    expect(JSON.parse(init.body)).toMatchObject({ layerId: "l2", content: "Gamma" });
  });

  it("renames a layer from a double-click on its row", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    const row = screen.getByRole("option", { name: /Draft/ });
    await fireEvent.dblClick(row);

    const input = screen.getByLabelText("Rename Draft");
    await fireEvent.input(input, { target: { value: "  Sketches  " } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/layers/l2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sketches" }),
    });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Sketches/ })).toBeInTheDocument(),
    );
  });

  it("abandons a rename on Escape", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.dblClick(screen.getByRole("option", { name: /Draft/ }));
    const input = screen.getByLabelText("Rename Draft");
    await fireEvent.input(input, { target: { value: "Nope" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: /Draft/ })).toBeInTheDocument();
  });

  it("reorders layers by dragging a row and restacks the canvas", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    // The popover lists top first: Draft, then Base. Dragging Base onto Draft's row
    // puts Base on top.
    const base = screen.getByRole("option", { name: /Base/ });
    const draft = screen.getByRole("option", { name: /Draft/ });
    await fireEvent.dragStart(base);
    await fireEvent.dragOver(draft);
    await fireEvent.drop(draft);

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/layers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Bottom to top: Draft is now below Base.
      body: JSON.stringify({ layerIds: ["l2", "l1"] }),
    });
    // Base is still the selected layer, so it keeps the top rank; Draft drops to 0.
    expect(layerGroup(container, "l1")).toHaveStyle({ "z-index": "1", opacity: "1" });
    expect(layerGroup(container, "l2")).toHaveStyle({ "z-index": "0", opacity: "0.3" });
  });

  it("reorders layers from the keyboard on the drag handle", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.keyDown(screen.getByLabelText("Reorder Base"), { key: "ArrowUp" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ layerIds: ["l2", "l1"] });
  });

  it("rolls back and reports when a reorder fails", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.keyDown(screen.getByLabelText("Reorder Base"), { key: "ArrowUp" });

    await waitFor(() => expect(screen.getByText("Failed to reorder layers")).toBeInTheDocument());
    // Base is selected, so it is on top either way; Draft must be back underneath it.
    expect(layerGroup(container, "l2")).toHaveStyle({ "z-index": "0" });
  });

  it("moves the selected cards to another layer and follows them there", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.mouseDown(screen.getByLabelText("Move selection to layer"));
    await fireEvent.mouseDown(screen.getByRole("option", { name: /Draft/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/cards/layer", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["card-1"], layerId: "l2" }),
    });
    // The card followed the move, and so did the selection: Draft is now in front.
    await waitFor(() =>
      expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "1", "z-index": "1" }),
    );
    expect(layerGroup(container, "l2")).toContainElement(
      screen.getByRole("button", { name: "Card: Alpha" }),
    );
  });

  it("puts the moved cards back when the server refuses", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.mouseDown(screen.getByLabelText("Move selection to layer"));
    await fireEvent.mouseDown(screen.getByRole("option", { name: /Draft/ }));

    await waitFor(() =>
      expect(screen.getByText("Failed to move cards to another layer")).toBeInTheDocument(),
    );
    expect(layerGroup(container, "l1")).toContainElement(
      screen.getByRole("button", { name: "Card: Alpha" }),
    );
  });

  it("keeps a dragged card at full strength even when its layer is dimmed", async () => {
    // The drop at the end of the drag saves positions; nothing here inspects that call.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
    );
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    // Select Draft, leaving card-1's layer (Base) dimmed, then start dragging that card.
    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(screen.getByRole("option", { name: /Draft/ }));
    expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "0.3" });

    const card = screen.getByRole("button", { name: "Card: Alpha" });
    await fireEvent.mouseDown(card, { clientX: 0, clientY: 0 });
    await fireEvent.mouseMove(window, { clientX: 40, clientY: 40 });

    // Floated to the top of the stack, and no longer faded: a drag is meant to be watched.
    await waitFor(() =>
      expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "1", "z-index": "1" }),
    );
    await fireEvent.mouseUp(window);
  });

  it("does not compound the scope dim with the layer dim", async () => {
    const scoped = {
      ...data,
      scopeRels: [{ scopeId: "scope-1", cardId: "card-2" }],
    };
    render(ProjectPage, {
      props: { data: scoped, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.click(screen.getByRole("button", { name: /Now/ }));
    // card-1 is outside the scope. On the active layer it fades; on a dimmed layer the
    // layer's own 0.3 is the whole story, and multiplying them would leave it invisible.
    const card = screen.getByRole("button", { name: "Card: Alpha" });
    expect(card).toHaveStyle({ opacity: "0.3" });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(screen.getByRole("option", { name: /Draft/ }));

    expect(card).toHaveStyle({ opacity: "1" });
  });

  it("comes back to the layer that was being worked on", async () => {
    const first = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });
    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(screen.getByRole("option", { name: /Draft/ }));
    first.unmount();

    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "1", "z-index": "1" });
  });

  it("shows the reason the server gives for a refused reorder", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        message: "The project's layers changed elsewhere. Reload to see the current order.",
      }),
    });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.keyDown(screen.getByLabelText("Reorder Base"), { key: "ArrowUp" });

    await waitFor(() =>
      expect(
        screen.getByText(
          "The project's layers changed elsewhere. Reload to see the current order.",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("creates a layer from the popover and makes it active", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "l3", name: "Notes", position: 2, isDefault: false }),
    });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    const input = screen.getByLabelText("New layer name");
    await fireEvent.input(input, { target: { value: "Notes" } });
    await fireEvent.click(screen.getByLabelText("Add layer"));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/layers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Notes" }),
    });
    await waitFor(() =>
      expect(layerGroup(container, "l3")).toHaveStyle({ opacity: "1", "z-index": "2" }),
    );
  });
});
