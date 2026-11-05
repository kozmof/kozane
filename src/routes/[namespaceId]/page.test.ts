import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import NamespacePage from "./+page.svelte";
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

describe("Namespace page", () => {
  it("names the browser tab after the namespace", () => {
    render(NamespacePage, {
      props: {
        data: { ...data, namespace: { ...data.namespace, name: "Research notes" } },
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });

    expect(document.title).toBe("Research notes");
  });

  it("uses the configured zoom step", async () => {
    const { container } = render(NamespacePage, {
      props: {
        data: { ...data, uiConfig: { ...data.uiConfig, zoomStep: 0.05 } },
        params: { namespaceId: "namespace-1" },
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

  it("shows the zoom, scope, layer, and side panel icons by default", () => {
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Focus a scope" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Layers" })).toBeInTheDocument();
    expect(screen.getByTitle("Hide panel")).toBeInTheDocument();
  });

  it("hides the zoom, scope, layer, and side panel icons when configured", () => {
    render(NamespacePage, {
      props: {
        data: {
          ...data,
          uiConfig: {
            ...data.uiConfig,
            showZoomControl: false,
            showScopeControl: false,
            showLayerControl: false,
            showSidePanelToggle: false,
          },
        },
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });

    expect(screen.queryByRole("button", { name: "Zoom in" })).not.toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Focus a scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Layers" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Hide panel")).not.toBeInTheDocument();
  });

  it("packs the visible top-right icons into one right-aligned row", () => {
    render(NamespacePage, {
      props: {
        data: {
          ...data,
          uiConfig: { ...data.uiConfig, showLayerControl: false, showSidePanelToggle: false },
        },
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });

    // The row is anchored to the right edge, so its only icon sits there with no gap for
    // the hidden ones.
    const row = screen.getByTestId("board-controls");
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(row.querySelector("button")).toBe(screen.getByRole("button", { name: "Focus a scope" }));
  });

  it("toggles the panels with the shortcut when their icon is hidden", async () => {
    const { container } = render(NamespacePage, {
      props: {
        data: { ...data, uiConfig: { ...data.uiConfig, showSidePanelToggle: false } },
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });
    const panels = container.querySelectorAll<HTMLElement>("aside");

    await fireEvent.keyDown(window, { key: "y" });

    expect([...panels].every((panel) => panel.style.width === "0px")).toBe(true);
  });

  it("uses the configured shortcuts to toggle footers and panels", async () => {
    const { container } = render(NamespacePage, {
      props: {
        data,
        params: { namespaceId: "namespace-1" },
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

    render(NamespacePage, {
      props: {
        data,
        params: { namespaceId: "namespace-1" },
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
   * Wait for a complete poll, including state application and release of the in-flight guard,
   * before starting another.
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
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) =>
      String(input) === "/api/changes"
        ? Promise.resolve(new Response('{"token":"baseline"}'))
        : fetch(input, init),
    );

    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await poll(fetch);
    // Nothing to revalidate against yet, so the first poll asks for the whole board.
    expect(new Headers(fetch.mock.calls[0][1].headers).has("if-none-match")).toBe(false);
    expect(snapshotJson).toHaveBeenCalledOnce();

    await poll(fetch);

    expect(fetch.mock.calls[1][0]).toBe("/namespace-1/api/snapshot");
    expect(fetch.mock.calls[1][1]).toMatchObject({
      cache: "no-store",
    });
    expect(new Headers(fetch.mock.calls[1][1].headers).get("if-none-match")).toBe('"board-1"');
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
    // Route mocked responses by URL because mutations and polls can interleave.
    let firstPoll = true;
    const fetch = vi.fn((url: unknown, _init?: RequestInit) => {
      if (!String(url).endsWith("/api/snapshot"))
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      if (!firstPoll) return Promise.resolve(tagged());
      firstPoll = false;
      return inFlight;
    });
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) =>
      String(input) === "/api/changes"
        ? Promise.resolve(new Response('{"token":"baseline"}'))
        : fetch(input, init),
    );

    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    // Start dragging after the poll begins so its response must be discarded.
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
    expect(new Headers(pollCall![1]?.headers).has("if-none-match")).toBe(false);
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

    render(NamespacePage, {
      props: { data: glued, params: { namespaceId: "namespace-1" }, form: null },
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
    render(NamespacePage, {
      props: {
        data,
        params: { namespaceId: "namespace-1" },
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
    const { container } = render(NamespacePage, {
      props: {
        data: { ...data, readonly: true },
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });

    // Keep partition filtering available in read-only exports.
    expect(screen.getByText("All cards")).toBeInTheDocument();

    // The composer, the create-partition/scope inputs, and the taskspace input
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
    render(NamespacePage, {
      props: {
        data,
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.click(screen.getByRole("button", { name: "Card: Beta" }), {
      shiftKey: true,
    });
    await fireEvent.click(screen.getByRole("button", { name: /Glue/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/namespace-1/api/glues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ["card-1", "card-2"] }),
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Unglue all/ })).toBeInTheDocument(),
    );
  });

  /** Select one card to enable the selection bar and its shortcuts. */
  async function selectAlpha() {
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
  }

  it("opens the file palette from the selection shortcut", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await selectAlpha();

    expect(screen.queryByRole("dialog", { name: "Edit a file" })).toBeNull();
    await fireEvent.keyDown(window, { key: "e" });

    expect(screen.getByRole("dialog", { name: "Edit a file" })).toBeInTheDocument();
  });

  it("opens it from the selection bar button too", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await selectAlpha();

    await fireEvent.click(screen.getByRole("button", { name: /Edit a file/ }));

    expect(screen.getByRole("dialog", { name: "Edit a file" })).toBeInTheDocument();
  });

  // The palette is the one overlay open while cards are selected, so the composer's own
  // window handler is live behind it. Without the suspend the cards the panel is about
  // would be deleted out from under it.
  it("does not delete the selection while the palette is over it", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    await selectAlpha();
    await fireEvent.keyDown(window, { key: "e" });

    await fireEvent.keyDown(window, { key: "Delete" });

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit a file" })).toBeInTheDocument();
  });

  it("gives the palette no shortcut when nothing is selected", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(NamespacePage, {
      props: { data, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.keyDown(window, { key: "e" });

    expect(screen.queryByRole("dialog", { name: "Edit a file" })).toBeNull();
  });
});

describe("Composer failures", () => {
  /** Types into the composer and submits, which is the path a new card takes. */
  async function compose(text: string) {
    const textarea = screen.getByLabelText("Write a card");
    await fireEvent.input(textarea, { target: { value: text } });
    await fireEvent.click(screen.getByRole("button", { name: "Create card" }));
  }

  // The limit the browser cannot foresee. Refusing with a fixed "Failed to create card"
  // left the writer retyping the same card to find out what was wrong with it, while the
  // CLI printed the reason for the same refusal.
  it("reports why the server refused a card, not just that it did", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: "content must be a string under 200000 characters" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    await compose("far too much text");

    expect(
      await screen.findByText("content must be a string under 200000 characters"),
    ).toBeInTheDocument();
  });

  it("falls back to its own wording when the refusal carries none", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 400, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    await compose("a card");

    expect(await screen.findByText("The request was not accepted")).toBeInTheDocument();
  });

  it("reports why an edit was refused", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: "content must be a string under 200000 characters" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    // Double-click to edit a card. A single click selects it.
    await fireEvent.dblClick(screen.getByRole("button", { name: "Card: Alpha" }));
    const textarea = await screen.findByLabelText("Edit card");
    await fireEvent.input(textarea, { target: { value: "far too much text" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("content must be a string under 200000 characters"),
    ).toBeInTheDocument();
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
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.click(screen.getByRole("button", { name: "Card: Beta" }), { shiftKey: true });
    await fireEvent.keyDown(window, { key: "r" });

    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();
  });

  it("widens the card on the drag and saves where it lands", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    const handle = await armAlpha();
    const card = screen.getByRole("button", { name: "Card: Alpha" });
    // Starts at the configured 210 and follows the pointer while the button is down.
    expect(card).toHaveStyle({ width: "210px" });

    await fireEvent.mouseDown(handle, { button: 0, clientX: 240 });
    await fireEvent.mouseMove(window, { clientX: 340 });
    expect(card).toHaveStyle({ width: "310px" });

    // Snap 310 to 312 on the 24-pixel grid at release.
    await fireEvent.mouseUp(window);
    expect(card).toHaveStyle({ width: "312px" });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      "/namespace-1/api/cards/card-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.any(Headers),
        body: JSON.stringify({ width: 312 }),
      }),
    );
  });

  it("saves nothing for a press that never became a drag", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    const handle = await armAlpha();
    await fireEvent.mouseDown(handle, { button: 0, clientX: 240 });
    await fireEvent.mouseUp(window);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("puts the old width back and reports when the save fails", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    const handle = await armAlpha();
    await fireEvent.mouseDown(handle, { button: 0, clientX: 240 });
    await fireEvent.mouseMove(window, { clientX: 340 });
    await fireEvent.mouseUp(window);

    // Restore null after the failed resize so the card follows `ui.defaultCardWidth` again.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Card: Alpha" })).toHaveStyle({ width: "210px" }),
    );
    expect(screen.getByText("Failed to save card width")).toBeInTheDocument();
  });

  it("takes the handle away when the selection behind it goes", async () => {
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

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
    render(NamespacePage, {
      props: { data: wide, params: { namespaceId: "namespace-1" }, form: null },
    });

    // Render exported card widths while disabling resize actions.
    expect(screen.getByRole("button", { name: "Card: Alpha" })).toHaveStyle({ width: "336px" });
    expect(screen.getByRole("button", { name: "Card: Beta" })).toHaveStyle({ width: "210px" });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    await fireEvent.keyDown(window, { key: "r" });
    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();
  });
});
