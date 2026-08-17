import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ProjectPage from "./+page.svelte";
import { SAFE_AREA_GRACE_MS } from "./lib/project-page";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/state";

// The page navigates between projects and tidies its own URL; both are the router's job,
// which does not exist outside a real SvelteKit app.
vi.mock("$app/navigation", () => ({ goto: vi.fn(), replaceState: vi.fn() }));

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
      width: null,
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
      width: null,
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
    warpMarkerSize: 14,
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
    resizeCardShortcut: "r",
    squashCardShortcut: "s",
    deleteCardsShortcut: "Delete",
    setWarpShortcut: "w",
    toggleWarpsShortcut: "W",
    removeWarpShortcut: "q",
    canvasWidth: 2800,
    canvasHeight: 2000,
  },
  // What the other projects contribute to the warp palette.
  warpDirectory: [
    {
      id: "warp-9",
      projectId: "project-2",
      projectName: "Research",
      label: 1,
      posX: 600,
      posY: 400,
      hint: "Umesao 1969",
      isCurrent: false,
    },
  ],
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

  /**
   * One poll, start to finish. `waitFor` sees a mock the moment it is *called*, which for
   * the snapshot body is well before the page has applied it and released its in-flight
   * guard — so the next poll would be dropped rather than sent.
   */
  async function poll(fetch: ReturnType<typeof vi.fn>) {
    const before = fetch.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("sends back the tag it holds and leaves the board alone when nothing changed", async () => {
    const snapshotJson = vi.fn(async () => data);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"board-1"' }),
        json: snapshotJson,
      })
      .mockResolvedValue({ ok: false, status: 304, headers: new Headers({ etag: '"board-1"' }) });
    vi.stubGlobal("fetch", fetch);

    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    await poll(fetch);
    // Nothing to revalidate against yet, so the first poll asks for the whole board.
    expect(fetch.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(snapshotJson).toHaveBeenCalledOnce();

    await poll(fetch);

    expect(fetch.mock.calls[1][0]).toBe("/project-1/api/snapshot");
    expect(fetch.mock.calls[1][1]).toMatchObject({
      cache: "no-store",
      headers: { "if-none-match": '"board-1"' },
    });
    // A 304 carries no body at all, so nothing is parsed and nothing is re-applied.
    expect(snapshotJson).toHaveBeenCalledOnce();
  });

  it("asks for the whole board again after a snapshot it could not apply", async () => {
    const snapshotJson = vi.fn(async () => data);
    const tagged = () => ({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"board-1"' }),
      json: snapshotJson,
    });
    let resolveSnapshot!: (response: ReturnType<typeof tagged>) => void;
    const inFlight = new Promise<ReturnType<typeof tagged>>((r) => (resolveSnapshot = r));
    // Routed by URL rather than by call order: the drop saves positions in between, and a
    // mutation's reply handed to the poll would be applied to the board as if it were one.
    let firstPoll = true;
    const fetch = vi.fn((url: unknown, _init?: RequestInit) => {
      if (!String(url).endsWith("/api/snapshot"))
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      if (!firstPoll) return Promise.resolve(tagged());
      firstPoll = false;
      return inFlight;
    });
    vi.stubGlobal("fetch", fetch);

    render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    // The poll goes out first; the drag starts while it is still in flight, which is what
    // makes the page drop the answer when it finally lands.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const card = screen.getByRole("button", { name: "Card: Alpha" });
    await fireEvent.mouseDown(card, { button: 0, clientX: 30, clientY: 60 });
    await fireEvent.mouseMove(window, { clientX: 222, clientY: 180 });

    resolveSnapshot(tagged());
    await waitFor(() => expect(snapshotJson).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Let the drop and its position save finish, so polling is allowed again.
    await fireEvent.mouseUp(window);
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    fetch.mockClear();
    await poll(fetch);

    // The dropped snapshot was never on the board, so claiming to hold its tag would leave
    // the page waiting forever on a change the server had already sent.
    const pollCall = fetch.mock.calls.find(([url]) => String(url).endsWith("/api/snapshot"))!;
    expect(pollCall).toBeDefined();
    expect(pollCall[1]).not.toHaveProperty("headers");
  });

  it("carries a glued partner along with the card under the pointer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const glued = {
      ...data,
      cards: data.cards.map((card) => ({ ...card, glueId: "g1" })),
      glueRels: [
        { glueId: "g1", cardId: "card-1" },
        { glueId: "g1", cardId: "card-2" },
      ],
    };

    render(ProjectPage, {
      props: { data: glued, params: { projectId: "project-1" }, form: null },
    });

    const alpha = screen.getByRole("button", { name: "Card: Alpha" });
    const beta = screen.getByRole("button", { name: "Card: Beta" });

    await fireEvent.mouseDown(alpha, { button: 0, clientX: 30, clientY: 60 });
    await fireEvent.mouseMove(window, { clientX: 222, clientY: 180 });

    // Alpha goes where the pointer took it. Beta is moved by the same delta rather than to
    // the same place, so the 72px the two were apart is still there afterwards.
    expect(alpha).toHaveStyle({ left: "216px", top: "168px" });
    expect(beta).toHaveStyle({ left: "288px", top: "168px" });

    await fireEvent.mouseUp(window);
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

describe("Card width", () => {
  /** Selects Alpha and arms its resize handle with the configured shortcut. */
  async function armAlpha() {
    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.keyDown(window, { key: "r" });
    return screen.getByLabelText("Drag to resize card width");
  }

  it("has no handle until a single card is armed", async () => {
    render(ProjectPage, { props: { data, params: { projectId: "project-1" }, form: null } });

    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.click(screen.getByRole("button", { name: "Card: Beta" }), { shiftKey: true });
    await fireEvent.keyDown(window, { key: "r" });

    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();
  });

  it("widens the card on the drag and saves where it lands", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, { props: { data, params: { projectId: "project-1" }, form: null } });

    const handle = await armAlpha();
    const card = screen.getByRole("button", { name: "Card: Alpha" });
    // Starts at the configured 210 and follows the pointer while the button is down.
    expect(card).toHaveStyle({ width: "210px" });

    await fireEvent.mouseDown(handle, { button: 0, clientX: 240 });
    await fireEvent.mouseMove(window, { clientX: 340 });
    expect(card).toHaveStyle({ width: "310px" });

    // The release snaps to the 24px grid the board is laid out on: 310 -> 312.
    await fireEvent.mouseUp(window);
    expect(card).toHaveStyle({ width: "312px" });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith("/project-1/api/cards/card-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ width: 312 }),
    });
  });

  it("saves nothing for a press that never became a drag", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, { props: { data, params: { projectId: "project-1" }, form: null } });

    const handle = await armAlpha();
    await fireEvent.mouseDown(handle, { button: 0, clientX: 240 });
    await fireEvent.mouseUp(window);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("puts the old width back and reports when the save fails", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, { props: { data, params: { projectId: "project-1" }, form: null } });

    const handle = await armAlpha();
    await fireEvent.mouseDown(handle, { button: 0, clientX: 240 });
    await fireEvent.mouseMove(window, { clientX: 340 });
    await fireEvent.mouseUp(window);

    // Back to following `ui.defaultCardWidth`, which is where the card started: the
    // failed save leaves it with no width of its own rather than with a stale 312.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Card: Alpha" })).toHaveStyle({ width: "210px" }),
    );
    expect(screen.getByText("Failed to save card width")).toBeInTheDocument();
  });

  it("takes the handle away when the selection behind it goes", async () => {
    render(ProjectPage, { props: { data, params: { projectId: "project-1" }, form: null } });

    await armAlpha();
    await fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();
  });

  it("draws a card at its own width and offers no handle in a read-only export", async () => {
    const wide = {
      ...data,
      readonly: true,
      cards: data.cards.map((card) => (card.id === "card-1" ? { ...card, width: 336 } : card)),
    };
    render(ProjectPage, { props: { data: wide, params: { projectId: "project-1" }, form: null } });

    // A static export renders the widths it was built with; it just cannot change them.
    expect(screen.getByRole("button", { name: "Card: Alpha" })).toHaveStyle({ width: "336px" });
    expect(screen.getByRole("button", { name: "Card: Beta" })).toHaveStyle({ width: "210px" });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.keyDown(window, { key: "r" });
    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();
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

  it("creates the card on the project navigated to, not the one left behind", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "card-9",
        bundleId: "b3",
        layerId: "l3",
        content: "Gamma",
        posX: 0,
        posY: 0,
        zIndex: 1,
        glueId: null,
        taskspaceId: null,
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(ProjectPage, {
      props: { data, params: { projectId: "project-1" }, form: null },
    });

    // Warping to another project keeps this component and swaps its data: the composer
    // has to swap with it, or it goes on offering a bundle that board does not have.
    const other = {
      ...data,
      project: { id: "project-2", name: "Research", isDefault: false },
      bundles: [{ id: "b3", projectId: "project-2", name: "General", isDefault: true }],
      layers: [{ id: "l3", projectId: "project-2", name: "Base", position: 0, isDefault: true }],
      cards: [],
      warps: [],
      warpDirectory: [],
    };
    await rerender({ data: other, params: { projectId: "project-2" }, form: null });

    const input = screen.getByLabelText("Write a card");
    await fireEvent.input(input, { target: { value: "Gamma" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/project-2/api/cards");
    expect(JSON.parse(init.body)).toMatchObject({ bundleId: "b3", layerId: "l3" });
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

  it("sets one warp however long the key is held down", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", projectId: "project-1", posX: 1400, posY: 1000 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ warps: [] });

    // A held key repeats about thirty times a second: every repeat that reached the
    // handler would be another POST and another marker stacked on the same point, with
    // only the topmost reachable to remove.
    await fireEvent.keyDown(window, { key: "w" });
    await fireEvent.keyDown(window, { key: "w", repeat: true });
    await fireEvent.keyDown(window, { key: "w", repeat: true });

    await waitFor(() => expect(screen.getByLabelText("Warp 1")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Warp 2")).not.toBeInTheDocument();
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

  it("wraps round rather than sticking on a warp the board cannot centre", async () => {
    // 2700 on the fixture's 2800-wide board: the scroll runs out before the warp reaches
    // the middle of an 800px viewport, so the warp goes on lying right of the view centre
    // even once the view has arrived on it — and pressing → again used to land back on it.
    const { container } = renderPage({
      warps: [
        { id: "warp-1", projectId: "project-1", posX: 600, posY: 1000 },
        { id: "warp-2", projectId: "project-1", posX: 2700, posY: 1000 },
      ],
    });
    const canvas = canvasOf(container);

    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(canvas.scrollLeft).toBe(2000);
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");

    // Back round to the leftmost warp, as it would from any other warp on the board.
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(canvas.scrollLeft).toBe(200);
    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps an edge warp as a destination once the view has panned off it", async () => {
    const { container } = renderPage({
      warps: [
        { id: "warp-1", projectId: "project-1", posX: 600, posY: 1000 },
        { id: "warp-2", projectId: "project-1", posX: 2700, posY: 1000 },
      ],
    });
    const canvas = canvasOf(container);

    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");

    // Dragged back to the middle of the board: the focused warp is somewhere to the right
    // again, so it is what → goes to, rather than something to wrap past.
    canvas.scrollLeft = 1000;
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(canvas.scrollLeft).toBe(2000);
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
  });

  it("does one thing when one key is bound to two warp actions", async () => {
    // `kozane doctor config` warns about a collision, but the config still loads and the
    // page still has to behave: one press must not both set a warp and remove one.
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", projectId: "project-1", posX: 1400, posY: 1000 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ uiConfig: { ...data.uiConfig, removeWarpShortcut: "w" } });

    await fireEvent.mouseDown(screen.getByLabelText("Warp 1"));
    await fireEvent.keyDown(window, { key: "w" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0][0]).toBe("/project-1/api/warps");
    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("data-warp-id", "warp-1");
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

  it("ignores a shortcut pressed with a modifier", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = renderPage();
    const canvas = canvasOf(container);

    // Cmd/Ctrl+A is select-all, and `event.key` is the bare "w"/"a" either way: without a
    // modifier guard each of these reads as a warp shortcut.
    await fireEvent.keyDown(window, { key: "w", metaKey: true });
    await fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await fireEvent.keyDown(window, { key: "q", metaKey: true });
    await fireEvent.keyDown(window, { key: "W", ctrlKey: true });
    await fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });

    expect(fetch).not.toHaveBeenCalled();
    // Nothing moved, nothing was hidden, nothing was focused.
    expect(canvas.scrollLeft).toBe(1000);
    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the markers again when an arrow key focuses one", async () => {
    renderPage({ uiConfig: { ...data.uiConfig, defaultShowWarps: false } });
    expect(screen.queryByLabelText("Warp 1")).not.toBeInTheDocument();

    // The remove key acts on the focused warp, so focusing one has to put it on screen.
    await fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(screen.getByLabelText("Warp 1")).toHaveAttribute("aria-pressed", "true");
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

  describe("palette", () => {
    const directoryResponse = (entries: unknown[]) =>
      vi.fn().mockResolvedValue({ ok: true, json: async () => entries });

    function openPalette() {
      return fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    }

    it("lists every project's warps, this one's first", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage();

      await openPalette();

      expect(screen.getByText("Project (this project)")).toBeInTheDocument();
      // By role: "Research" is also the name of a bundle in the left panel.
      expect(screen.getByRole("listbox", { name: "Research" })).toBeInTheDocument();
      const rows = screen.getAllByRole("option");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("Warp 1");
      expect(rows[3]).toHaveTextContent("Umesao 1969");
    });

    it("re-reads the other projects' warps when it opens", async () => {
      const fetch = directoryResponse([
        { ...data.warpDirectory[0], id: "warp-10", hint: "set in another tab" },
      ]);
      vi.stubGlobal("fetch", fetch);
      renderPage();

      await openPalette();

      expect(fetch).toHaveBeenCalledWith("/project-1/api/warp-directory");
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /set in another tab/ })).toBeInTheDocument(),
      );
    });

    it("keeps the warps it was given when the re-read fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      renderPage();

      await openPalette();

      await waitFor(() =>
        expect(screen.getByRole("option", { name: /Umesao 1969/ })).toBeInTheDocument(),
      );
    });

    it("keeps the warps it was given when the re-read is not a list of rows", async () => {
      // A palette row is rendered whole and then scrolled to, so a body that is not one
      // is treated as no answer at all rather than listed as `undefined`.
      vi.stubGlobal("fetch", directoryResponse([{ id: "warp-10", projectName: "Research" }]));
      renderPage();

      await openPalette();

      await waitFor(() =>
        expect(screen.getByRole("option", { name: /Umesao 1969/ })).toBeInTheDocument(),
      );
    });

    it("asks for nothing in a read-only export", async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      renderPage({ readonly: true });

      await openPalette();

      expect(screen.getByRole("dialog", { name: "Warps" })).toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("moves the view to a warp of this project without navigating", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      const { container } = renderPage();
      const canvas = canvasOf(container);

      await openPalette();
      await fireEvent.click(screen.getByRole("option", { name: /Warp 2/ }));

      // Centred on warp 2 at x=2400: 2400 − half the 800px viewport.
      expect(canvas.scrollLeft).toBe(2000);
      expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("dialog", { name: "Warps" })).not.toBeInTheDocument();
      expect(goto).not.toHaveBeenCalled();
    });

    it("navigates to the other project, naming the warp it is headed for", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage();

      await openPalette();
      await fireEvent.click(screen.getByRole("option", { name: /Umesao 1969/ }));

      expect(goto).toHaveBeenCalledWith("/project-2?warp=warp-9");
    });

    it("removes another project's warp and renumbers what is left of it", async () => {
      const second = { ...data.warpDirectory[0], id: "warp-8", label: 2, hint: "second" };
      const fetch = directoryResponse([data.warpDirectory[0], second]);
      vi.stubGlobal("fetch", fetch);
      renderPage({ warpDirectory: [data.warpDirectory[0], second] });

      await openPalette();
      await fireEvent.click(screen.getByRole("button", { name: "Remove warp 1 in Research" }));

      expect(fetch).toHaveBeenCalledWith("/project-2/api/warps/warp-9", { method: "DELETE" });
      await waitFor(() =>
        expect(screen.queryByRole("option", { name: /Umesao 1969/ })).not.toBeInTheDocument(),
      );
      // What was warp 2 in that project is now its warp 1.
      expect(screen.getByRole("option", { name: /second/ })).toHaveTextContent("Warp 1");
    });

    it("puts another project's warp back when removing it fails", async () => {
      const fetch = vi
        .fn()
        .mockImplementation((url: string) =>
          url.includes("warp-directory")
            ? Promise.resolve({ ok: true, json: async () => data.warpDirectory })
            : Promise.resolve({ ok: false, json: async () => ({ message: "gone wrong" }) }),
        );
      vi.stubGlobal("fetch", fetch);
      renderPage();

      await openPalette();
      await fireEvent.click(screen.getByRole("button", { name: "Remove warp 1 in Research" }));

      await waitFor(() => expect(screen.getByText("gone wrong")).toBeInTheDocument());
      expect(screen.getByRole("option", { name: /Umesao 1969/ })).toBeInTheDocument();
    });

    it("removes one of this project's warps through the same path as the x key", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage();

      await openPalette();
      await fireEvent.click(screen.getByRole("button", { name: "Remove warp 1 in Project" }));

      await waitFor(() =>
        expect(screen.queryByRole("option", { name: /^Warp 3/ })).not.toBeInTheDocument(),
      );
      // The marker on the board goes with it, and the rest renumber.
      expect(screen.queryByLabelText("Warp 3")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Warp 1")).toHaveAttribute("data-warp-id", "warp-2");
    });

    it("keeps the trailing slash a static export's pages are served under", async () => {
      const previous = page.url;
      page.url = new URL("http://localhost/project-1/") as typeof page.url;
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage({ readonly: true });

      await openPalette();
      await fireEvent.click(screen.getByRole("option", { name: /Umesao 1969/ }));

      // Without it the export's static server redirects, and the redirect is where a
      // query string is easiest to lose.
      expect(goto).toHaveBeenCalledWith("/project-2/?warp=warp-9");
      page.url = previous;
    });

    it("does not open while cards are selected", async () => {
      vi.stubGlobal("fetch", vi.fn());
      renderPage();

      await fireEvent.click(screen.getByLabelText("Card: Alpha"));
      await openPalette();

      expect(screen.queryByRole("dialog", { name: "Warps" })).not.toBeInTheDocument();
    });

    it("closes on the same key that opened it", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage();

      await openPalette();
      await fireEvent.keyDown(screen.getByRole("dialog", { name: "Warps" }), {
        key: "ArrowUp",
        shiftKey: true,
      });

      expect(screen.queryByRole("dialog", { name: "Warps" })).not.toBeInTheDocument();
    });
  });

  describe("landing from another project", () => {
    // The cast is for SvelteKit's typed-routes URL, which the test stub does not brand.
    const visit = (url: string) => (page.url = new URL(url) as typeof page.url);

    afterEach(() => {
      visit("http://localhost/project-1");
    });

    it("opens on the warp the url names and highlights it", async () => {
      visit("http://localhost/project-1?warp=warp-2");
      vi.stubGlobal("fetch", vi.fn());

      const { container } = renderPage();

      // Warp 2 sits at x=2400, y=1000: half a viewport back from each.
      expect(canvasOf(container).scrollLeft).toBe(2000);
      expect(canvasOf(container).scrollTop).toBe(700);
      expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
      // And the query is dropped, so panning away and reloading does not snap back.
      await waitFor(() => expect(replaceState).toHaveBeenCalledWith("/project-1", {}));
    });

    it("opens the next project in the middle rather than where the last one was left", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const { container, rerender } = render(ProjectPage, {
        props: { data, params: { projectId: "project-1" }, form: null },
      });

      await fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(canvasOf(container).scrollLeft).toBe(1400);

      // Navigating with no warp to land on: the Back button, or a jump to a warp that has
      // been removed since the palette listed it.
      await rerender({
        data: { ...data, project: { id: "project-2", name: "Research", isDefault: false } },
        params: { projectId: "project-2" },
        form: null,
      });

      await waitFor(() => expect(canvasOf(container).scrollLeft).toBe(1000));
    });

    it("drops the warp it landed on from the query and leaves the rest alone", async () => {
      visit("http://localhost/project-1?warp=warp-2&scope=reading");
      vi.stubGlobal("fetch", vi.fn());

      renderPage();

      await waitFor(() =>
        expect(replaceState).toHaveBeenCalledWith("/project-1?scope=reading", {}),
      );
    });

    it("opens in the middle of the board when the warp is gone", () => {
      visit("http://localhost/project-1?warp=removed-elsewhere");
      vi.stubGlobal("fetch", vi.fn());

      const { container } = renderPage();

      expect(canvasOf(container).scrollLeft).toBe(1000);
    });
  });
});

describe("Squash", () => {
  const splittable = {
    ...data,
    cards: [{ ...data.cards[0], content: "First thought. Second thought" }, data.cards[1]],
  };

  const pieces = [
    {
      id: "card-3",
      bundleId: "b1",
      layerId: "l1",
      content: "First thought",
      posX: 24,
      posY: 48,
      zIndex: 0,
      glueId: null,
      taskspaceId: null,
      width: null,
    },
    {
      id: "card-4",
      bundleId: "b1",
      layerId: "l1",
      content: "Second thought",
      posX: 304,
      posY: 48,
      zIndex: 1,
      glueId: null,
      taskspaceId: null,
      width: null,
    },
  ];

  it("replaces the selected card with the pieces the server answers with", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cards: pieces }) });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data: splittable, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.click(
      screen.getByRole("button", { name: "Card: First thought. Second thought" }),
    );
    await fireEvent.keyDown(window, { key: "s" });

    expect(fetch).toHaveBeenCalledWith("/project-1/api/cards/squash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: "card-1" }),
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Card: First thought" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Card: Second thought" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Card: First thought. Second thought" }),
    ).not.toBeInTheDocument();
    // The pieces are what is selected now, so the next action lands on them.
    expect(screen.getByText("2 cards")).toBeInTheDocument();
  });

  it("offers nothing to press for a card with no split in it", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cards: [] }) });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, { props: { data, params: { projectId: "project-1" }, form: null } });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    expect(screen.getByRole("button", { name: /^Squash/ })).toBeDisabled();

    await fireEvent.keyDown(window, { key: "s" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the reason the server gave and leaves the card alone", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Card text splits into more than 2000 cards" }),
    });
    vi.stubGlobal("fetch", fetch);
    render(ProjectPage, {
      props: { data: splittable, params: { projectId: "project-1" }, form: null },
    });

    await fireEvent.click(
      screen.getByRole("button", { name: "Card: First thought. Second thought" }),
    );
    await fireEvent.click(screen.getByRole("button", { name: /^Squash/ }));

    expect(
      await screen.findByText("Card text splits into more than 2000 cards"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Card: First thought. Second thought" }),
    ).toBeInTheDocument();
  });
});
