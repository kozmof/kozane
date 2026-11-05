import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import NamespacePage from "./+page.svelte";
import { SAFE_AREA_GRACE_MS } from "./lib/namespace-page.js";
import { data } from "./page.fixtures.js";

// Stub router behavior for namespace navigation, URL cleanup, and unsaved-file guards.
vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  replaceState: vi.fn(),
  beforeNavigate: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Layers", () => {
  function layerGroup(container: HTMLElement, layerId: string): HTMLElement {
    return container.querySelector<HTMLElement>(`[data-layer-id="${layerId}"]`)!;
  }

  /**
   * Match the layer selection button at the start of its accessible name to exclude delete
   * and reorder controls.
   */
  function layerOption(name: string): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(`^${name}`) });
  }

  /** The row that handles drag-and-drop reordering. */
  function layerRow(container: HTMLElement, layerId: string): HTMLElement {
    return container.querySelector<HTMLElement>(`[data-layer-row="${layerId}"]`)!;
  }

  it("stacks the active layer on top and dims the others", () => {
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    // The default Base layer starts active, fully opaque and above the others.
    expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "1", "z-index": "1" });
    expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "0.3", "z-index": "0" });
  });

  it("restacks when another layer is selected from the hover popover", async () => {
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));

    expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "1", "z-index": "1" });
    expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "0.3", "z-index": "0" });
  });

  it("keeps cards on dimmed layers clickable", async () => {
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));

    // Let wrapper events reach the card.
    expect(layerGroup(container, "l1")).toHaveStyle({ "pointer-events": "none" });
    const card = screen.getByRole("button", { name: "Card: Alpha" });
    expect(card).toHaveStyle({ "pointer-events": "auto" });
    await fireEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "true");
  });

  it("does not sweep cards on dimmed layers into a rectangle selection", async () => {
    const spread = {
      ...data,
      // Keep Alpha on active Base and move Beta to dimmed Draft.
      cards: [data.cards[0], { ...data.cards[1], layerId: "l2" }],
    };
    const { container } = render(NamespacePage, {
      props: { data: spread, params: { namespaceId: "namespace-1" }, form: null },
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
        partitionId: "b1",
        layerId: "l2",
        content: "Gamma",
        posX: 0,
        posY: 0,
        zIndex: 1,
        glueId: null,
        taskspaceId: null,
        inventory: null,
      }),
    });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));

    const input = screen.getByLabelText("Write a card");
    await fireEvent.input(input, { target: { value: "Gamma" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/namespace-1/api/cards");
    expect(JSON.parse(init.body)).toMatchObject({ layerId: "l2", content: "Gamma" });
    // The server stacks the card inside its transaction. A value from this board's copy
    // could tie with a card another writer added since the last poll.
    expect(JSON.parse(init.body)).not.toHaveProperty("zIndex");
  });

  it("creates the card on the namespace navigated to, not the one left behind", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "card-9",
        partitionId: "b3",
        layerId: "l3",
        content: "Gamma",
        posX: 0,
        posY: 0,
        zIndex: 1,
        glueId: null,
        taskspaceId: null,
        inventory: null,
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    // Update the composer when namespace navigation reuses the page so it offers the new
    // board's partitions.
    const other = {
      ...data,
      namespace: { id: "namespace-2", name: "Research", isDefault: false },
      partitions: [{ id: "b3", namespaceId: "namespace-2", name: "General", isDefault: true }],
      layers: [
        { id: "l3", namespaceId: "namespace-2", name: "Base", position: 0, isDefault: true },
      ],
      cards: [],
      warps: [],
      warpDirectory: [],
    };
    await rerender({ data: other, params: { namespaceId: "namespace-2" }, form: null });

    const input = screen.getByLabelText("Write a card");
    await fireEvent.input(input, { target: { value: "Gamma" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/namespace-2/api/cards");
    expect(JSON.parse(init.body)).toMatchObject({ partitionId: "b3", layerId: "l3" });
  });

  it("renames a layer from a double-click on its row", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    const row = layerOption("Draft");
    await fireEvent.dblClick(row);

    const input = screen.getByLabelText("Rename Draft");
    await fireEvent.input(input, { target: { value: "  Sketches  " } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      "/namespace-1/api/layers/l2",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.any(Headers),
        body: JSON.stringify({ name: "Sketches" }),
      }),
    );
    expect(new Headers(fetch.mock.calls[0][1].headers).get("content-type")).toBe(
      "application/json",
    );
    await waitFor(() => expect(layerOption("Sketches")).toBeInTheDocument());
  });

  it("abandons a rename on Escape", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
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
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    // The popover lists Draft above Base. Drag Base's row onto Draft to place it on top. Drag
    // the row rather than its button.
    const base = layerRow(container, "l1");
    const draft = layerRow(container, "l2");
    await fireEvent.dragStart(base);
    await fireEvent.dragOver(draft);
    await fireEvent.drop(draft);

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      "/namespace-1/api/layers",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.any(Headers),
        // From bottom to top, Draft is now below Base.
        body: JSON.stringify({ layerIds: ["l2", "l1"] }),
      }),
    );
    expect(new Headers(fetch.mock.calls[0][1].headers).get("content-type")).toBe(
      "application/json",
    );
    // Keep active Base above Draft after reordering.
    expect(layerGroup(container, "l1")).toHaveStyle({ "z-index": "1", opacity: "1" });
    expect(layerGroup(container, "l2")).toHaveStyle({ "z-index": "0", opacity: "0.3" });
  });

  it("reorders layers from the keyboard on the drag handle", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.keyDown(screen.getByLabelText("Reorder Base"), { key: "ArrowUp" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ layerIds: ["l2", "l1"] });
  });

  it("rolls back and reports when a reorder fails", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.keyDown(screen.getByLabelText("Reorder Base"), { key: "ArrowUp" });

    await waitFor(() => expect(screen.getByText("Failed to reorder layers")).toBeInTheDocument());
    // Restore Draft below active Base.
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
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });
    const control = await openLayerPopover({ left: 0, top: 40, right: 180, bottom: 200 });

    // Leaving the button just above the panel, heading diagonally for a row inside it.
    await fireEvent.mouseLeave(control, { clientX: 100, clientY: 20 });
    await fireEvent.mouseMove(document, { clientX: 60, clientY: 35 });

    expect(screen.queryByRole("list", { name: "Layers" })).toBeInTheDocument();
  });

  it("closes when the pointer leaves the corridor to the popover", async () => {
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });
    const control = await openLayerPopover({ left: 0, top: 40, right: 180, bottom: 200 });

    await fireEvent.mouseLeave(control, { clientX: 100, clientY: 20 });
    // Place the pointer away from the target.
    await fireEvent.mouseMove(document, { clientX: 300, clientY: 35 });

    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Layers" })).not.toBeInTheDocument(),
    );
  });

  it("gives up on a pointer that stops inside the corridor", async () => {
    vi.useFakeTimers();
    try {
      render(NamespacePage, {
        props: { data, params: { namespaceId: "namespace-1" }, form: null },
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
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.mouseDown(screen.getByLabelText("Move selection to layer"));
    await fireEvent.mouseDown(screen.getByRole("option", { name: /Draft/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      "/namespace-1/api/cards/layer",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.any(Headers),
        body: JSON.stringify({ cardIds: ["card-1"], layerId: "l2" }),
      }),
    );
    expect(new Headers(fetch.mock.calls[0][1].headers).get("content-type")).toBe(
      "application/json",
    );
    // Select Draft after moving the card there so its layer appears in front.
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
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
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
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
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
    // The drag also saves positions, but this test does not inspect that request.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
    );
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    // Select Draft, leaving card-1's layer (Base) dimmed, then start dragging that card.
    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));
    expect(layerGroup(container, "l1")).toHaveStyle({ opacity: "0.3" });

    const card = screen.getByRole("button", { name: "Card: Alpha" });
    await fireEvent.mouseDown(card, { clientX: 0, clientY: 0 });
    await fireEvent.mouseMove(window, { clientX: 40, clientY: 40 });

    // Show the dragged card at full opacity above the stack.
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
    render(NamespacePage, {
      props: { data: scoped, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.click(screen.getByLabelText("Focus a scope"));
    await fireEvent.click(screen.getByRole("option", { name: /Now/ }));
    // Do not multiply scope dimming by layer dimming. The layer's opacity alone should apply
    // to an inactive layer.
    const card = screen.getByRole("button", { name: "Card: Alpha" });
    expect(card).toHaveStyle({ opacity: "0.3" });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));

    expect(card).toHaveStyle({ opacity: "1" });
  });

  it("comes back to the layer that was being worked on", async () => {
    const first = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });
    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.click(layerOption("Draft"));
    first.unmount();

    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    expect(layerGroup(container, "l2")).toHaveStyle({ opacity: "1", "z-index": "1" });
  });

  it("shows the reason the server gives for a refused reorder", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              message: "The namespace's layers changed elsewhere. Reload to see the current order.",
            }),
            {
              status: 409,
              headers: { "content-type": "application/json", "X-Kozane-Error-Code": "conflict" },
            },
          ),
      );
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    await fireEvent.keyDown(screen.getByLabelText("Reorder Base"), { key: "ArrowUp" });

    await waitFor(() =>
      expect(
        screen.getByText(
          "The namespace's layers changed elsewhere. Reload to see the current order.",
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
    const { container } = render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.mouseEnter(screen.getByLabelText("Layers").parentElement!);
    const input = screen.getByLabelText("New layer name");
    await fireEvent.input(input, { target: { value: "Notes" } });
    await fireEvent.click(screen.getByLabelText("Add layer"));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      "/namespace-1/api/layers",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify({ name: "Notes" }),
      }),
    );
    expect(new Headers(fetch.mock.calls[0][1].headers).get("content-type")).toBe(
      "application/json",
    );
    await waitFor(() =>
      expect(layerGroup(container, "l3")).toHaveStyle({ opacity: "1", "z-index": "2" }),
    );
  });
});
