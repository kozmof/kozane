import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
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

describe("Squash", () => {
  const splittable = {
    ...data,
    cards: [{ ...data.cards[0], content: "First thought. Second thought" }, data.cards[1]],
  };

  const pieces = [
    {
      id: "card-3",
      createdAt: "2026-11-05T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
      partitionId: "b1",
      layerId: "l1",
      content: "First thought",
      posX: 24,
      posY: 48,
      zIndex: 0,
      glueId: null,
      taskspaceId: null,
      inventory: { id: "inv-squash", slot: 0 },
      width: null,
    },
    {
      id: "card-4",
      createdAt: "2026-11-05T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
      partitionId: "b1",
      layerId: "l1",
      content: "Second thought",
      posX: 304,
      posY: 48,
      zIndex: 1,
      glueId: null,
      taskspaceId: null,
      inventory: { id: "inv-squash", slot: 1 },
      width: null,
    },
  ];

  const squashInventory = {
    id: "inv-squash",
    namespaceId: "namespace-1",
    name: "Squash 1",
    posX: 24,
    posY: 48,
  };

  it("replaces the selected card with an open inventory holding the pieces", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ inventory: squashInventory, cards: pieces, stacking: [] }),
    });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data: splittable, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.click(
      screen.getByRole("button", { name: "Card: First thought. Second thought" }),
    );
    await fireEvent.keyDown(window, { key: "s" });

    expect(fetch).toHaveBeenCalledWith(
      "/namespace-1/api/cards/squash",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify({ cardId: "card-1" }),
      }),
    );
    const opened = await screen.findByRole("region", { name: "Inventory Squash 1" });
    expect(within(opened).getByRole("button", { name: "Card: First thought" })).toBeInTheDocument();
    expect(
      within(opened).getByRole("button", { name: "Card: Second thought" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Card: First thought. Second thought" }),
    ).not.toBeInTheDocument();
  });

  it("reports a failure when the answer leaves out the inventory", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cards: pieces }) });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data: splittable, params: { namespaceId: "namespace-1" }, form: null },
    });

    await fireEvent.click(
      screen.getByRole("button", { name: "Card: First thought. Second thought" }),
    );
    await fireEvent.keyDown(window, { key: "s" });

    expect(await screen.findByText("Invalid mutation response")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Card: First thought. Second thought" }),
    ).toBeInTheDocument();
  });

  it("offers nothing to press for a card with no split in it", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cards: [] }) });
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, { props: { data, params: { namespaceId: "namespace-1" }, form: null } });

    await fireEvent.click(screen.getByRole("button", { name: "Card: Alpha" }));
    expect(screen.getByRole("button", { name: /^Squash/ })).toBeDisabled();

    await fireEvent.keyDown(window, { key: "s" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the reason the server gave and leaves the card alone", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Card text splits into more than 2000 cards" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    render(NamespacePage, {
      props: { data: splittable, params: { namespaceId: "namespace-1" }, form: null },
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

describe("Scoped-file export", () => {
  // Embed taskspace trees with `--include-scoped-files`, but keep local paths null in
  // published data.
  function exportData(suffix: string) {
    const taskspaceId = `taskspace-${suffix}`;
    return {
      ...data,
      readonly: true,
      namespace: { id: `namespace-${suffix}`, name: `Namespace ${suffix}`, isDefault: false },
      cards: [],
      warps: [],
      warpDirectory: [],
      scopes: [{ id: `scope-${suffix}`, name: `Scope ${suffix}` }],
      taskspaces: [
        {
          id: taskspaceId,
          name: `taskspace-in-${suffix}`,
          scopeId: `scope-${suffix}`,
          path: null,
          pathKind: "workspace_relative" as const,
        },
      ],
      taskspaceFiles: {
        [taskspaceId]: {
          root: {
            kind: "directory" as const,
            name: "",
            truncated: null,
            children: [
              { kind: "file" as const, name: `${suffix}.md`, content: `# ${suffix}`, size: 8 },
            ],
          },
        },
      },
    };
  }

  it("browses the arriving namespace's files after warping, not the one it was opened on", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const first = exportData("a");
    const { rerender } = render(NamespacePage, {
      props: { data: first, params: { namespaceId: "namespace-a" }, form: null },
    });

    // Refresh embedded trees when namespace navigation reuses the component. Static
    // taskspaces have no live path to fall back to.
    const second = exportData("b");
    await rerender({ data: second, params: { namespaceId: "namespace-b" }, form: null });

    await fireEvent.keyDown(window, { key: "o" });
    const browser = within(screen.getByRole("dialog", { name: "Files" }));
    await fireEvent.click(browser.getByRole("option", { name: /Scope b/ }));
    const row = browser.getByRole("option", { name: "taskspace-in-b" });
    expect(row).toBeInTheDocument();

    // And it is the arriving namespace's tree behind the row, not a leftover.
    await fireEvent.click(row);
    expect(await browser.findByText("b.md")).toBeInTheDocument();
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
  });
});

describe("Namespace page inventories", () => {
  const bag = { id: "inv-1", namespaceId: "namespace-1", name: "Bag", posX: 600, posY: 400 };
  /** Card 2 stored in slot 3 of the bag, card 1 still on the canvas. */
  const withStoredCard = {
    ...data,
    inventories: [bag],
    cards: data.cards.map((c) =>
      c.id === "card-2" ? { ...c, inventory: { id: "inv-1", slot: 3 } } : c,
    ),
  };

  function renderPage(overrides: Partial<typeof withStoredCard> = {}) {
    return render(NamespacePage, {
      props: {
        data: { ...withStoredCard, ...overrides },
        params: { namespaceId: "namespace-1" },
        form: null,
      },
    });
  }

  it("draws a stored card in its grid rather than on the canvas", async () => {
    const { container } = renderPage();

    expect(container.querySelector('[data-card-id="card-1"]')).not.toBeNull();
    expect(container.querySelector('[data-card-id="card-2"]')).toBeNull();
    const icon = screen.getByRole("button", { name: "Bag" });
    expect(icon).toHaveAttribute("aria-expanded", "false");

    // A press that never moves is a click on the icon, which opens the grid.
    await fireEvent.mouseDown(icon, { button: 0, clientX: 10, clientY: 10 });
    await fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });

    const grid = await screen.findByRole("region", { name: "Inventory Bag" });
    // Slot 3 is the first row's fourth column.
    const stored = grid.querySelector<HTMLElement>('[data-stored-card-id="card-2"]')!;
    expect(stored).toHaveTextContent("Beta");
    expect(stored.style.gridRow).toBe("1 / span 1");
    expect(stored.style.gridColumn).toBe("4");
    expect(icon).toHaveAttribute("aria-expanded", "true");
  });

  it("selects a stored card for the composer when it is clicked in the grid", async () => {
    const { container } = renderPage();
    await fireEvent.mouseDown(screen.getByRole("button", { name: "Bag" }), { button: 0 });
    await fireEvent.mouseUp(window);

    const stored = await waitFor(() => container.querySelector('[data-stored-card-id="card-2"]')!);
    await fireEvent.click(stored);

    expect(stored).toHaveAttribute("aria-pressed", "true");
  });

  it("adds an inventory with its shortcut and opens it", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "inv-new",
        namespaceId: "namespace-1",
        name: "",
        posX: 1200,
        posY: 850,
      }),
    });
    vi.stubGlobal("fetch", fetch);
    renderPage({ inventories: [] });

    await fireEvent.keyDown(window, { key: "v" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/namespace-1/api/inventories");
    expect(init.method).toBe("POST");
    expect(
      await screen.findByRole("region", { name: "Inventory Inventory 1" }),
    ).toBeInTheDocument();
  });

  it("puts the cards back on the canvas when an inventory is removed", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ releasedCardIds: ["card-2"] }) });
    vi.stubGlobal("fetch", fetch);
    const { container } = renderPage();
    await fireEvent.mouseDown(screen.getByRole("button", { name: "Bag" }), { button: 0 });
    await fireEvent.mouseUp(window);

    await fireEvent.click(await screen.findByRole("button", { name: "Remove inventory Bag" }));

    await waitFor(() => expect(container.querySelector('[data-card-id="card-2"]')).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Bag/ })).toBeNull();
    expect(fetch.mock.calls[0][1].method).toBe("DELETE");
  });

  it("puts a new card in the open inventory, and names it in the composer", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "card-new",
        partitionId: "b1",
        layerId: "l1",
        content: "Gamma",
        posX: 0,
        posY: 0,
        zIndex: 1,
        taskspaceId: null,
        glueId: null,
        width: null,
        inventory: { id: "inv-1", slot: 0 },
        placements: [{ cardId: "card-new", inventoryId: "inv-1", slot: 0 }],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const { container } = renderPage();
    const input = screen.getByRole("textbox", { name: "Write a card" });
    expect(input).not.toHaveAttribute("placeholder");

    await fireEvent.mouseDown(screen.getByRole("button", { name: "Bag" }), { button: 0 });
    await fireEvent.mouseUp(window);
    await waitFor(() => expect(input).toHaveAttribute("placeholder", "Add to Bag"));

    await fireEvent.input(input, { target: { value: "Gamma" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      content: "Gamma",
      inventoryId: "inv-1",
    });
    const grid = screen.getByRole("region", { name: "Inventory Bag" });
    const stored = await waitFor(() => {
      const found = grid.querySelector<HTMLElement>('[data-stored-card-id="card-new"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(stored.style.gridColumn).toBe("1");
    expect(container.querySelector('[data-card-id="card-new"]')).toBeNull();
  });

  it("draws a long stored card down as many rows as its text needs", async () => {
    const long = "word ".repeat(40).trim();
    const { container } = renderPage({
      cards: withStoredCard.cards.map((c) => (c.id === "card-2" ? { ...c, content: long } : c)),
    });
    await fireEvent.mouseDown(screen.getByRole("button", { name: "Bag" }), { button: 0 });
    await fireEvent.mouseUp(window);

    const stored = await waitFor(
      () => container.querySelector<HTMLElement>('[data-stored-card-id="card-2"]')!,
    );
    const span = Number(stored.dataset.span);
    expect(span).toBeGreaterThan(1);
    // Slot 3 is the first row's fourth column.
    expect(stored.style.gridRow).toBe(`1 / span ${span}`);
    expect(stored.style.gridColumn).toBe("4");
    expect(stored).toHaveTextContent(long);
  });
});
