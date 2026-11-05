import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import NamespacePage from "./+page.svelte";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/state";
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

describe("Warps", () => {
  // Supply an 800×600 viewport on the 2800×2000 fixture canvas because jsdom provides no
  // layout. This centers the initial view at (1400, 1000).
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
    return render(NamespacePage, {
      props: {
        data: { ...data, ...overrides },
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });
  }

  function canvasOf(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>('[role="presentation"]')!;
  }

  it("sets a warp under the mouse pointer", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", namespaceId: "namespace-1", posX: 1200, posY: 850 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ warps: [] });

    // Client (200, 150) over a canvas scrolled to (1000, 700) is world (1200, 850).
    await fireEvent.mouseMove(window, { clientX: 200, clientY: 150 });
    await fireEvent.keyDown(window, { key: "w" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/namespace-1/api/warps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posX: 1200, posY: 850 }),
    });
    await waitFor(() => expect(screen.getByLabelText("Warp 1")).toBeInTheDocument());
  });

  it("falls back to the centre of the view when the pointer is off the canvas", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", namespaceId: "namespace-1", posX: 1400, posY: 1000 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ warps: [] });

    // Place the pointer beyond the canvas's right edge.
    await fireEvent.mouseMove(window, { clientX: 1200, clientY: 150 });
    await fireEvent.keyDown(window, { key: "w" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/namespace-1/api/warps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posX: 1400, posY: 1000 }),
    });
    await waitFor(() => expect(screen.getByLabelText("Warp 1")).toBeInTheDocument());
  });

  it("sets one warp however long the key is held down", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", namespaceId: "namespace-1", posX: 1400, posY: 1000 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ warps: [] });

    // Ignore key repeats so holding the shortcut cannot create overlapping warp markers.
    await fireEvent.keyDown(window, { key: "w" });
    await fireEvent.keyDown(window, { key: "w", repeat: true });
    await fireEvent.keyDown(window, { key: "w", repeat: true });

    await waitFor(() => expect(screen.getByLabelText("Warp 1")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Warp 2")).not.toBeInTheDocument();
  });

  it("moves a warp by dragging its marker, and keeps the row the server stored", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-1", namespaceId: "namespace-1", posX: 1850, posY: 1050 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage();

    // Warp 1 sits at world (1800, 1000) on a canvas scrolled to (1000, 700), which puts it
    // at client (800, 300). Fifty pixels down and right of that, at zoom 1, is (1850, 1050).
    const marker = screen.getByLabelText("Warp 1");
    await fireEvent.mouseDown(marker, { button: 0, clientX: 800, clientY: 300 });
    await fireEvent.mouseMove(window, { clientX: 850, clientY: 350 });
    await fireEvent.mouseUp(window);

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      "/namespace-1/api/warps/warp-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.any(Headers),
        body: JSON.stringify({ posX: 1850, posY: 1050 }),
      }),
    );
    // Half the marker's 14px diameter back from the centre it was dropped on.
    await waitFor(() => expect(screen.getByLabelText("Warp 1")).toHaveStyle({ left: "1843px" }));
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

    // Centre warp 1 by subtracting half the 800-pixel viewport from x=1800.
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

    // Moving right from the rightmost warp wraps to the leftmost.
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByLabelText("Warp 3")).toHaveAttribute("aria-pressed", "true");
  });

  it("wraps round rather than sticking on a warp the board cannot centre", async () => {
    // Place the warp beyond the viewport's reachable center so repeated right navigation must
    // move past it rather than select it again.
    const { container } = renderPage({
      warps: [
        { id: "warp-1", namespaceId: "namespace-1", posX: 600, posY: 1000 },
        { id: "warp-2", namespaceId: "namespace-1", posX: 2700, posY: 1000 },
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
        { id: "warp-1", namespaceId: "namespace-1", posX: 600, posY: 1000 },
        { id: "warp-2", namespaceId: "namespace-1", posX: 2700, posY: 1000 },
      ],
    });
    const canvas = canvasOf(container);

    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");

    // After panning back, the focused warp is to the right and becomes the next rightward
    // destination.
    canvas.scrollLeft = 1000;
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(canvas.scrollLeft).toBe(2000);
    expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
  });

  it("does one thing when one key is bound to two warp actions", async () => {
    // A shortcut collision must trigger only one action, even though the configuration loads
    // with a warning.
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "warp-new", namespaceId: "namespace-1", posX: 1400, posY: 1000 }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ uiConfig: { ...data.uiConfig, removeWarpShortcut: "w" } });

    await fireEvent.mouseDown(screen.getByLabelText("Warp 1"));
    await fireEvent.keyDown(window, { key: "w" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0][0]).toBe("/namespace-1/api/warps");
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
    expect(fetch).toHaveBeenCalledWith("/namespace-1/api/warps/warp-1", { method: "DELETE" });
    // Renumber the two remaining warps so the former warp 2 becomes warp 1.
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

    // Check modifiers so Cmd/Ctrl shortcuts with the same `event.key` do not trigger warp
    // actions.
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
      json: async () => ({ id: "warp-new", namespaceId: "namespace-1", posX: 1400, posY: 1000 }),
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

    it("lists every namespace's warps, this one's first", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage();

      await openPalette();

      expect(screen.getByText("Namespace (this namespace)")).toBeInTheDocument();
      // Find by role because a partition is also named Research.
      expect(screen.getByRole("listbox", { name: "Research" })).toBeInTheDocument();
      const rows = screen.getAllByRole("option");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("Warp 1");
      expect(rows[3]).toHaveTextContent("Umesao 1969");
    });

    it("re-reads the other namespaces' warps when it opens", async () => {
      const fetch = directoryResponse([
        { ...data.warpDirectory[0], id: "warp-10", hint: "set in another tab" },
      ]);
      vi.stubGlobal("fetch", fetch);
      renderPage();

      await openPalette();

      expect(fetch).toHaveBeenCalledWith("/namespace-1/api/warp-directory");
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
      vi.stubGlobal("fetch", directoryResponse([{ id: "warp-10", namespaceName: "Research" }]));
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

    it("moves the view to a warp of this namespace without navigating", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      const { container } = renderPage();
      const canvas = canvasOf(container);

      await openPalette();
      await fireEvent.click(screen.getByRole("option", { name: /Warp 2/ }));

      // Centre warp 2 by subtracting half the 800-pixel viewport from x=2400.
      expect(canvas.scrollLeft).toBe(2000);
      expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("dialog", { name: "Warps" })).not.toBeInTheDocument();
      expect(goto).not.toHaveBeenCalled();
    });

    it("navigates to the other namespace, naming the warp it is headed for", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage();

      await openPalette();
      await fireEvent.click(screen.getByRole("option", { name: /Umesao 1969/ }));

      expect(goto).toHaveBeenCalledWith("/namespace-2?warp=warp-9");
    });

    it("removes another namespace's warp and renumbers what is left of it", async () => {
      const second = { ...data.warpDirectory[0], id: "warp-8", label: 2, hint: "second" };
      const fetch = directoryResponse([data.warpDirectory[0], second]);
      vi.stubGlobal("fetch", fetch);
      renderPage({ warpDirectory: [data.warpDirectory[0], second] });

      await openPalette();
      await fireEvent.click(screen.getByRole("button", { name: "Remove warp 1 in Research" }));

      expect(fetch).toHaveBeenCalledWith("/namespace-2/api/warps/warp-9", { method: "DELETE" });
      await waitFor(() =>
        expect(screen.queryByRole("option", { name: /Umesao 1969/ })).not.toBeInTheDocument(),
      );
      // What was warp 2 in that namespace is now its warp 1.
      expect(screen.getByRole("option", { name: /second/ })).toHaveTextContent("Warp 1");
    });

    it("puts another namespace's warp back when removing it fails", async () => {
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

    it("removes one of this namespace's warps through the same path as the x key", async () => {
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage();

      await openPalette();
      await fireEvent.click(screen.getByRole("button", { name: "Remove warp 1 in Namespace" }));

      await waitFor(() =>
        expect(screen.queryByRole("option", { name: /^Warp 3/ })).not.toBeInTheDocument(),
      );
      // The marker on the board goes with it, and the rest renumber.
      expect(screen.queryByLabelText("Warp 3")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Warp 1")).toHaveAttribute("data-warp-id", "warp-2");
    });

    it("keeps the trailing slash a static export's pages are served under", async () => {
      const previous = page.url;
      page.url = new URL("http://localhost/namespace-1/") as typeof page.url;
      vi.stubGlobal("fetch", directoryResponse(data.warpDirectory));
      renderPage({ readonly: true });

      await openPalette();
      await fireEvent.click(screen.getByRole("option", { name: /Umesao 1969/ }));

      // Without it the export's static server redirects, and the redirect is where a
      // query string is easiest to lose.
      expect(goto).toHaveBeenCalledWith("/namespace-2/?warp=warp-9");
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

  describe("landing from another namespace", () => {
    // The cast is for SvelteKit's typed-routes URL, which the test stub does not brand.
    const visit = (url: string) => (page.url = new URL(url) as typeof page.url);

    afterEach(() => {
      visit("http://localhost/namespace-1");
    });

    it("opens on the warp the url names and highlights it", async () => {
      visit("http://localhost/namespace-1?warp=warp-2");
      vi.stubGlobal("fetch", vi.fn());

      const { container } = renderPage();

      // Centre the viewport on warp 2 at (2400, 1000).
      expect(canvasOf(container).scrollLeft).toBe(2000);
      expect(canvasOf(container).scrollTop).toBe(700);
      expect(screen.getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
      // And the query is dropped, so panning away and reloading does not snap back.
      await waitFor(() => expect(replaceState).toHaveBeenCalledWith("/namespace-1", {}));
    });

    it("opens the next namespace in the middle rather than where the last one was left", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const { container, rerender } = render(NamespacePage, {
        props: { data, params: { namespaceId: "namespace-1" }, form: null },
      });

      await fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(canvasOf(container).scrollLeft).toBe(1400);

      // Handle navigation without a destination warp, including Back and links to removed
      // warps.
      await rerender({
        data: { ...data, namespace: { id: "namespace-2", name: "Research", isDefault: false } },
        params: { namespaceId: "namespace-2" },
        form: null,
      });

      await waitFor(() => expect(canvasOf(container).scrollLeft).toBe(1000));
    });

    it("drops the warp it landed on from the query and leaves the rest alone", async () => {
      visit("http://localhost/namespace-1?warp=warp-2&scope=reading");
      vi.stubGlobal("fetch", vi.fn());

      renderPage();

      await waitFor(() =>
        expect(replaceState).toHaveBeenCalledWith("/namespace-1?scope=reading", {}),
      );
    });

    it("opens in the middle of the board when the warp is gone", () => {
      visit("http://localhost/namespace-1?warp=removed-elsewhere");
      vi.stubGlobal("fetch", vi.fn());

      const { container } = renderPage();

      expect(canvasOf(container).scrollLeft).toBe(1000);
    });
  });

  /**
   * Tag links use `?card=` or `?taskspace=&path=` to open their sources. Consume and remove
   * these parameters once so reloading does not repeat the jump.
   */
  describe("landing from the tag index", () => {
    const visit = (url: string) => (page.url = new URL(url) as typeof page.url);

    // Around the centre the stubbed canvas metrics produce, so centring on it is visible.
    const target = { ...data.cards[0], id: "card-far", content: "Gamma", posX: 1800, posY: 1000 };
    const withTarget = { cards: [...data.cards, target] };

    // Clear shared mock calls so earlier tests cannot affect URL-cleanup assertions.
    beforeEach(() => {
      vi.mocked(replaceState).mockClear();
    });

    afterEach(() => {
      visit("http://localhost/namespace-1");
    });

    it("centres on the card the url names and selects it", async () => {
      visit("http://localhost/namespace-1?card=card-far");
      vi.stubGlobal("fetch", vi.fn());

      const { container } = renderPage(withTarget);

      await waitFor(() => expect(canvasOf(container).scrollLeft).toBe(1400));
      expect(canvasOf(container).scrollTop).toBe(700);
      // Select the centred card so the matched source is clear on a dense board.
      expect(screen.getByRole("button", { name: "Card: Gamma" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("drops the card it landed on from the query and leaves the rest alone", async () => {
      visit("http://localhost/namespace-1?card=card-far&scope=reading");
      vi.stubGlobal("fetch", vi.fn());

      renderPage(withTarget);

      await waitFor(() =>
        expect(replaceState).toHaveBeenCalledWith("/namespace-1?scope=reading", {}),
      );
    });

    it("centres on the inventory holding a stored card and opens its grid", async () => {
      visit("http://localhost/namespace-1?card=card-far");
      vi.stubGlobal("fetch", vi.fn());

      // The card's own position is where it last sat on the canvas, far from the bag.
      const bag = { id: "inv-1", namespaceId: "namespace-1", name: "Bag", posX: 1200, posY: 800 };
      const { container } = render(NamespacePage, {
        props: {
          data: {
            ...data,
            inventories: [bag],
            cards: [...data.cards, { ...target, inventory: { id: "inv-1", slot: 0 } }],
          },
          params: { namespaceId: "namespace-1" },
          form: null,
        },
      });

      await waitFor(() => expect(canvasOf(container).scrollLeft).toBe(800));
      expect(canvasOf(container).scrollTop).toBe(500);
      const grid = await screen.findByRole("region", { name: "Inventory Bag" });
      expect(grid.querySelector('[data-stored-card-id="card-far"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("opens in the middle of the board when the card is gone", async () => {
      // A tag page left open while the card it listed was deleted from another tab.
      visit("http://localhost/namespace-1?card=deleted-elsewhere");
      vi.stubGlobal("fetch", vi.fn());

      const { container } = renderPage(withTarget);

      expect(canvasOf(container).scrollLeft).toBe(1000);
      // Nothing was acted on, so nothing is dropped and the URL is left as it was found.
      expect(replaceState).not.toHaveBeenCalled();
    });

    /**
     * `data.taskspaces` is empty above, so its element type is `never` and a taskspace
     * cannot be handed to `renderPage`. Built as a whole object instead, which is what the
     * scoped-file suite below does for the same reason.
     */
    const withTaskspace = (overrides: Record<string, unknown> = {}) => ({
      ...data,
      ...withTarget,
      taskspaces: [
        {
          id: "taskspace-1",
          name: "notes",
          scopeId: "scope-1",
          path: "notes",
          pathKind: "workspace_relative" as const,
        },
      ],
      ...overrides,
    });

    it("centres on a card and opens a file when the url names both", async () => {
      visit(
        "http://localhost/namespace-1?card=card-far&taskspace=taskspace-1&path=notes%2Ftodo.md",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ content: "See :perf here.", signature: "sig-1" }),
        }),
      );

      const { container } = render(NamespacePage, {
        props: { data: withTaskspace(), params: { namespaceId: "namespace-1" }, form: null },
      });

      expect(await screen.findByLabelText("Editing notes/todo.md")).toBeInTheDocument();
      await waitFor(() => expect(canvasOf(container).scrollLeft).toBe(1400));
      // Remove both handled URL parameters in one navigation.
      expect(replaceState).toHaveBeenCalledWith("/namespace-1", {});
    });

    it("gives the board its shortcuts back while the editor is pinned", async () => {
      visit("http://localhost/namespace-1?taskspace=taskspace-1&path=notes%2Ftodo.md");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ content: "notes", signature: "sig-1" }),
        }),
      );
      const { container } = render(NamespacePage, {
        props: { data: withTaskspace(), params: { namespaceId: "namespace-1" }, form: null },
      });
      await screen.findByLabelText("Editing notes/todo.md");
      const footer = container.querySelector<HTMLElement>("[style*='visibility']");

      // An open editor owns the keyboard, so the footer shortcut does nothing.
      await fireEvent.keyDown(window, { key: "x" });
      expect(footer).toHaveStyle({ visibility: "visible" });

      await fireEvent.click(screen.getByRole("button", { name: "Pin editor" }));
      await fireEvent.keyDown(window, { key: "x" });
      expect(footer).toHaveStyle({ visibility: "hidden" });
      expect(screen.getByLabelText("Editing notes/todo.md")).toBeInTheDocument();
    });

    it("leaves a file link inert in an export that carries no files", async () => {
      visit("http://localhost/namespace-1?taskspace=taskspace-1&path=notes%2Ftodo.md");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      render(NamespacePage, {
        props: {
          // An export's taskspace rows carry no local path, and without
          // `--include-scoped-files` no baked tree either.
          data: withTaskspace({
            readonly: true,
            taskspaces: [
              {
                id: "taskspace-1",
                name: "notes",
                scopeId: "scope-1",
                path: null,
                pathKind: "workspace_relative" as const,
              },
            ],
          }),
          params: { namespaceId: "namespace-1" },
          form: null,
        },
      });

      // Without the baked-in contents there is nothing to read and no endpoint to read it
      // from, so the editor must not open on an error rather than on a file.
      expect(screen.queryByLabelText("Editing notes/todo.md")).not.toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
