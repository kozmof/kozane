import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import InventoryWindow from "./InventoryWindow.svelte";

function mount(props: Record<string, unknown> = {}) {
  const onRename = vi.fn();
  render(InventoryWindow, {
    props: {
      inventory: { id: "inv-1", namespaceId: "namespace-1", name: "", posX: 0, posY: 0 },
      label: "Inventory 1",
      cards: [],
      selectedCards: new Set<string>(),
      draggingCardId: null,
      dropTarget: null,
      fontFamily: "monospace",
      onClose: vi.fn(),
      onRemove: vi.fn(),
      onRename,
      onCardMouseDown: vi.fn(),
      onCardClick: vi.fn(),
      onCardDblClick: vi.fn(),
      ...props,
    },
  });
  return { onRename };
}

const nameField = () => screen.getByRole("textbox", { name: "Inventory name" });

describe("InventoryWindow renaming", () => {
  it("starts renaming from the rename button", async () => {
    const { onRename } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Rename inventory Inventory 1" }));

    expect(nameField()).toHaveFocus();
    await userEvent.type(nameField(), "Ideas{Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Ideas");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("saves once when the rename button is pressed again", async () => {
    const { onRename } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Rename inventory Inventory 1" }));
    await userEvent.type(nameField(), "Ideas");

    await userEvent.click(screen.getByRole("button", { name: "Save inventory name" }));
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Ideas");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("starts from the current name", async () => {
    mount({
      inventory: { id: "inv-1", namespaceId: "namespace-1", name: "Bag", posX: 0, posY: 0 },
      label: "Bag",
    });
    await userEvent.click(screen.getByRole("button", { name: "Rename inventory Bag" }));
    expect(nameField()).toHaveValue("Bag");
  });

  it("keeps the old name on Escape", async () => {
    const { onRename } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Rename inventory Inventory 1" }));
    await userEvent.type(nameField(), "Ideas{Escape}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Inventory 1" })).toBeInTheDocument();
  });

  it("still renames on a double-click of the title", async () => {
    const { onRename } = mount();
    await userEvent.dblClick(screen.getByRole("button", { name: "Inventory 1" }));
    await userEvent.type(nameField(), "Ideas{Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Ideas");
  });

  it("offers no rename in a read-only export", () => {
    mount({ readonly: true });
    expect(screen.queryByRole("button", { name: /Rename inventory/ })).toBeNull();
  });
});
