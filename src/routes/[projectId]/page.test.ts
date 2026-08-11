import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ProjectPage from "./+page.svelte";
import { SAFE_AREA_GRACE_MS } from "./lib/project-page";

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
  // Around the centre of the view the stubbed canvas metrics below produce: (1400, 1000).
  warps: [
    { id: "warp-1", projectId: "project-1", posX: 1800, posY: 1000 },
    { id: "warp-2", projectId: "project-1", posX: 2400, posY: 1000 },
    { id: "warp-3", projectId: "project-1", posX: 1400, posY: 1600 },
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
    defaultShowWarps: true,
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
    setWarpShortcut: "w",
    toggleWarpsShortcut: "W",
    removeWarpShortcut: "q",
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

  /**
   * The button that selects a layer in the popover. Its accessible name is the layer name
   * followed by its card count, so it is anchored at the start to keep "Delete Draft" and
   * "Reorder Draft" — the row's other buttons — out of the match.
   */
  function layerOption(name: string): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(`^${name}`) });
  }

  /** The row itself, which is what carries the drag-and-drop reordering. */
  function layerRow(container: HTMLElement, layerId: string): HTMLElement {
    return container.querySelector<HTMLElement>(`[data-layer-row="${layerId}"]`)!;
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
    await fireEvent.click(layerOption("Draft"));

    expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "1", "z-index": "1" });
    expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "0.3", "z-index": "0" });
  });

  it("keeps cards on dimmed layers clickable", async () => {
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));

    // The wrapper lets events through; the card itself still receives them.
    expect(layerGroup(container, "l1")).toHaveStyle({ "pointer-events": "none" });
    const card = screen.getByRole("button", { name: "Card: Alpha" });
    expect(card).toHaveStyle({ "pointer-events": "auto" });
    await fireEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "true");
  });

  it("does not sweep cards on dimmed layers into a rectangle selection", async () => {
    const spread = {
      ...data,
      // Alpha stays on Base, the active layer; Beta moves to the dimmed Draft.
      cards: [data.cards[0], { ...data.cards[1], layerId: "l2" }],
    };
    const { container } = render(ProjectPage, {
      props: { data: spread, params: { projectId: "project-1" }, form: null },
    });

    // jsdom lays nothing out, so the canvas and both cards are told where they are. Both
    // cards sit inside the rectangle dragged below.
    const canvas = container.querySelector<HTMLElement>('[role="presentation"]')!;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
    for (const el of container.querySelectorAll<HTMLElement>("[data-card-id]")) {
      el.getBoundingClientRect = () =>
        ({ left: 10, top: 10, right: 200, bottom: 60, width: 190, height: 50 }) as DOMRect;
    }

    // Shift-drag across the whole area is the rubber band.
    await fireEvent.mouseDown(canvas, { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    await fireEvent.mouseMove(window, { clientX: 400, clientY: 300 });
    await fireEvent.mouseUp(window);

    expect(screen.getByRole("button", { name: "Card: Alpha" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Card: Beta" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
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
    await fireEvent.click(layerOption("Draft"));

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
    const row = layerOption("Draft");
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
    await waitFor(() => expect(layerOption("Sketches")).toBeInTheDocument());
  });

  it("abandons a rename on Escape", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.dblClick(layerOption("Draft"));
    const input = screen.getByLabelText("Rename Draft");
    await fireEvent.input(input, { target: { value: "Nope" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(fetch).not.toHaveBeenCalled();
    expect(layerOption("Draft")).toBeInTheDocument();
  });

  it("reorders layers by dragging a row and restacks the canvas", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    // The popover lists top first: Draft, then Base. Dragging Base onto Draft's row
    // puts Base on top. The row is what is draggable, not the button inside it.
    const base = layerRow(container, "l1");
    const draft = layerRow(container, "l2");
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

  /** Opens the layer popover and gives its panel a real rect, which jsdom does not. */
  async function openLayerPopover(panelRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) {
    const control = screen.getByLabelText("Layers").parentElement!;
    await fireEvent.mouseEnter(control);
    const panel = screen.getByRole("list", { name: "Layers" }).parentElement!;
    panel.getBoundingClientRect = () => ({ ...panelRect, width: 0, height: 0 }) as DOMRect;
    return control;
  }

  it("stays open while the pointer cuts the corner towards the popover", async () => {
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });
    const control = await openLayerPopover({ left: 0, top: 40, right: 180, bottom: 200 });

    // Leaving the button just above the panel, heading diagonally for a row inside it.
    await fireEvent.mouseLeave(control, { clientX: 100, clientY: 20 });
    await fireEvent.mouseMove(document, { clientX: 60, clientY: 35 });

    expect(screen.queryByRole("list", { name: "Layers" })).toBeInTheDocument();
  });

  it("closes when the pointer leaves the corridor to the popover", async () => {
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });
    const control = await openLayerPopover({ left: 0, top: 40, right: 180, bottom: 200 });

    await fireEvent.mouseLeave(control, { clientX: 100, clientY: 20 });
    // Off to the side: this pointer was never coming here.
    await fireEvent.mouseMove(document, { clientX: 300, clientY: 35 });

    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Layers" })).not.toBeInTheDocument(),
    );
  });

  it("gives up on a pointer that stops inside the corridor", async () => {
    vi.useFakeTimers();
    try {
      render(ProjectPage, {
        props: { data, params: { projectId: "project-1" }, form: null },
      });
      const control = await openLayerPopover({ left: 0, top: 40, right: 180, bottom: 200 });

      await fireEvent.mouseLeave(control, { clientX: 100, clientY: 20 });
      await fireEvent.mouseMove(document, { clientX: 60, clientY: 35 });
      expect(screen.queryByRole("list", { name: "Layers" })).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(SAFE_AREA_GRACE_MS);

      expect(screen.queryByRole("list", { name: "Layers" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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

  it("restacks the moved cards where the server says they landed", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, stacking: [{ cardId: "card-1", zIndex: 7 }] }),
    });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    // zIndex orders cards within a layer, so arriving on Draft earns a new one.
    expect(screen.getByRole("button", { name: "Card: Alpha" })).toHaveStyle({ "z-index": "0" });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.mouseDown(screen.getByLabelText("Move selection to layer"));
    await fireEvent.mouseDown(screen.getByRole("option", { name: /Draft/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Card: Alpha" })).toHaveStyle({ "z-index": "7" }),
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
    await fireEvent.click(layerOption("Draft"));
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
    await fireEvent.click(layerOption("Draft"));

    expect(card).toHaveStyle({ opacity: "1" });
  });

  it("comes back to the layer that was being worked on", async () => {
    const first = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });
    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));
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

describe("Warps", () => {
  // jsdom does no layout, so the canvas would report a zero-sized viewport and every warp
  // would land on the same scroll offset. These are the numbers a real 800×600 viewport on
  // the fixture's 2800×2000 canvas would produce, which puts the initial view centre at
  // (1400, 1000) — the point the fixture's warps are arranged around.
  const metrics: Record<string, number> = {
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 2800,
    scrollHeight: 2000,
  };

  // jsdom's getBoundingClientRect is all zeroes, which would put every pointer outside the
  // canvas. This is the rect the metrics above describe.
  const rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };

  beforeEach(() => {
    for (const [name, value] of Object.entries(metrics)) {
      Object.defineProperty(HTMLDivElement.prototype, name, { configurable: true, value });
    }
    Object.defineProperty(HTMLDivElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => rect }),
    });
  });

  afterEach(() => {
    for (const name of [...Object.keys(metrics), "getBoundingClientRect"]) {
      Reflect.deleteProperty(HTMLDivElement.prototype, name);
    }
  });

  function renderPage(overrides: Partial<typeof data> = {}) {
    return render(ProjectPage, {
      props: { data: { ...data, ...overrides }, params: { projectId: "project-1" }, form: null },
    });
  }

  function canvasOf(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>('[role="presentation"]')!;
  }

  it("sets a warp under the mouse pointer", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", projectId: "project-1", posX: 1200, posY: 850 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ warps: [] });

    // Client (200, 150) over a canvas scrolled to (1000, 700) is world (1200, 850).
    await fireEvent.mouseMove(window, { clientX: 200, clientY: 150 });
    await fireEvent.keyDown(window, { key: "w" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/warps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posX: 1200, posY: 850 }),
    });
    await waitFor(() => expect(screen.getByLabelText("Warp 1")).toBeInTheDocument());
  });

  it("falls back to the centre of the view when the pointer is off the canvas", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", projectId: "project-1", posX: 1400, posY: 1000 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ warps: [] });

    // Past the right edge of the canvas rect: a side panel, or another window.
    await fireEvent.mouseMove(window, { clientX: 1200, clientY: 150 });
    await fireEvent.keyDown(window, { key: "w" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/warps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posX: 1400, posY: 1000 }),
    });
    await waitFor(() => expect(screen.getByLabelText("Warp 1")).toBeInTheDocument());
  });

  it("numbers the markers in creation order", () => {
    renderPage();

    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("data-warp-id", "warp-1");
    expect(screen.getByLabelText("Warp 3")).toHaveAttribute("data-warp-id", "warp-3");
  });

  it("moves the view to the nearest warp in the direction pressed", async () => {
    const { container } = renderPage();
    const canvas = canvasOf(container);
    expect(canvas.scrollLeft).toBe(1000);

    await fireEvent.keyDown(window, { key: "ArrowRight" });

    // Centred on warp 1 at x=1800: 1800 − half the 800px viewport.
    expect(canvas.scrollLeft).toBe(1400);
    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("aria-pressed", "true");

    // And on from there, rather than back to the same warp.
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(canvas.scrollLeft).toBe(2000);
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
  });

  it("wraps back round the board once there is nothing further that way", async () => {
    const { container } = renderPage();
    const canvas = canvasOf(container);

    await fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(canvas.scrollTop).toBe(1300);
    expect(screen.getByLabelText("Warp 3")).toHaveAttribute("aria-pressed", "true");

    // Warp 3 is the bottom one, so pressing on returns to the topmost.
    await fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(canvas.scrollTop).toBe(700);
    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("aria-pressed", "true");

    // The same the other way: warp 2 is the rightmost, so → restarts at the leftmost.
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByLabelText("Warp 3")).toHaveAttribute("aria-pressed", "true");
  });

  it("focuses a warp that is clicked", async () => {
    renderPage();

    await fireEvent.mouseDown(screen.getByLabelText("Warp 2"));

    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
  });

  it("removes the focused warp", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    renderPage();

    await fireEvent.keyDown(window, { key: "ArrowRight" });
    await fireEvent.keyDown(window, { key: "q" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/warps/warp-1", { method: "DELETE" });
    // Two warps left, renumbered: what was warp 2 is now warp 1.
    expect(screen.queryByLabelText("Warp 3")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("data-warp-id", "warp-2");
  });

  it("removes nothing when no warp is focused", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderPage();

    await fireEvent.keyDown(window, { key: "q" });

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Warp 1")).toBeInTheDocument();
  });

  it("hides and shows the markers with the toggle key", async () => {
    renderPage();

    await fireEvent.keyDown(window, { key: "W" });
    expect(screen.queryByLabelText("Warp 1")).not.toBeInTheDocument();

    await fireEvent.keyDown(window, { key: "W" });
    expect(screen.getByLabelText("Warp 1")).toBeInTheDocument();
  });

  it("reveals hidden markers when a warp is set", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", projectId: "project-1", posX: 1400, posY: 1000 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ uiConfig: { ...data.uiConfig, defaultShowWarps: false } });
    expect(screen.queryByLabelText("Warp 1")).not.toBeInTheDocument();

    await fireEvent.keyDown(window, { key: "w" });

    await waitFor(() => expect(screen.getByLabelText("Warp 4")).toBeInTheDocument());
  });

  it("leaves the keyboard to the selection while cards are selected", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = renderPage();
    const canvas = canvasOf(container);

    await fireEvent.click(screen.getByLabelText("Card: Alpha"));
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    await fireEvent.keyDown(window, { key: "w" });

    expect(canvas.scrollLeft).toBe(1000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps warping in a read-only export but never writes", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = renderPage({ readonly: true });
    const canvas = canvasOf(container);

    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(canvas.scrollLeft).toBe(1400);

    await fireEvent.keyDown(window, { key: "w" });
    await fireEvent.keyDown(window, { key: "q" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
