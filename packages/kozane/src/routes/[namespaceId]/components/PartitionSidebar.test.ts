import { expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import PartitionSidebar from "../../../../../client/src/board/components/PartitionSidebar.svelte";
const props = () => ({
  visible: true,
  namespacesHref: "/",
  panelWidth: 220,
  partitions: [
    { id: "general", namespaceId: "ns", name: "General", isDefault: true, dot: "#000", bg: "#fff" },
  ],
  activePartition: null,
  newPartitionName: "",
  onCreatePartition: vi.fn(),
  onDeletePartition: vi.fn(),
  onRenamePartition: vi.fn(async () => null as string | null),
});
it("renames General with inline editing and preserves its default protection", async () => {
  const user = userEvent.setup();
  const options = props();
  render(PartitionSidebar, { props: options });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  const input = screen.getByRole("textbox", { name: "Partition name" });
  await user.clear(input);
  await user.type(input, "Inbox{Enter}");
  expect(options.onRenamePartition).toHaveBeenCalledWith("general", "Inbox");
  expect(screen.queryByTitle("Delete partition")).not.toBeInTheDocument();
});
it("allows keyboard rename and cancellation without saving", async () => {
  const user = userEvent.setup();
  const options = props();
  render(PartitionSidebar, { props: options });
  screen.getByRole("button", { name: /^General/ }).focus();
  await user.keyboard("{F2}");
  await user.type(screen.getByRole("textbox", { name: "Partition name" }), "changed{Escape}");
  expect(options.onRenamePartition).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Partition name" })).not.toBeInTheDocument();
});
it("retains the editor and shows rejected names", async () => {
  const user = userEvent.setup();
  const options = props();
  options.onRenamePartition.mockResolvedValue("Duplicate partition");
  render(PartitionSidebar, { props: options });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  await user.type(screen.getByRole("textbox", { name: "Partition name" }), "other{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Duplicate partition");
});
it("does not rename partitions in a read-only view", async () => {
  const user = userEvent.setup();
  render(PartitionSidebar, { props: { ...props(), readonly: true } });
  await user.dblClick(screen.getByRole("button", { name: /^General/ }));
  expect(screen.queryByRole("button", { name: "Rename General" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Partition name" })).not.toBeInTheDocument();
});

it("opens renaming from the edit icon on the partition row", async () => {
  const user = userEvent.setup();
  const options = props();
  render(PartitionSidebar, { props: options });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  expect(screen.getByRole("textbox", { name: "Partition name" })).toHaveValue("General");
});

it("selects immediately and keeps repeated clicks on the same partition selected", async () => {
  render(PartitionSidebar, { props: props() });
  const row = screen.getByRole("button", { name: /^General/ });
  await fireEvent.click(row, { detail: 1 });
  expect(row).toHaveAttribute("aria-pressed", "true");
  await fireEvent.click(row, { detail: 2 });
  expect(row).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("textbox", { name: "Partition name" })).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: /^All cards/ }));
  expect(row).toHaveAttribute("aria-pressed", "false");
});
it("opens the edit control without changing the current filter", async () => {
  const user = userEvent.setup();
  render(PartitionSidebar, { props: props() });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: /^General/ })).toHaveAttribute("aria-pressed", "false");
});

it("renames on double-click without clearing the partition filter", async () => {
  const user = userEvent.setup();
  render(PartitionSidebar, { props: props() });
  await user.dblClick(screen.getByRole("button", { name: /^General/ }));
  expect(screen.getByRole("textbox", { name: "Partition name" })).toHaveValue("General");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: /^General/ })).toHaveAttribute("aria-pressed", "true");
});
it("restores focus to the edit icon after saving and cancelling", async () => {
  const user = userEvent.setup();
  render(PartitionSidebar, { props: props() });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  await user.type(screen.getByRole("textbox", { name: "Partition name" }), "Inbox{Enter}");
  await waitFor(() => expect(screen.getByRole("button", { name: "Rename General" })).toHaveFocus());
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Rename General" })).toHaveFocus();
});
it("restores focus to the row after cancelling keyboard renaming", async () => {
  const user = userEvent.setup();
  render(PartitionSidebar, { props: props() });
  screen.getByRole("button", { name: /^General/ }).focus();
  await user.keyboard("{F2}{Escape}");
  expect(screen.getByRole("button", { name: /^General/ })).toHaveFocus();
});
it("does not close another editor or steal its focus when an older save completes", async () => {
  const user = userEvent.setup();
  const options = props();
  options.partitions.push({
    ...options.partitions[0],
    id: "other",
    name: "Other",
    isDefault: false,
  });
  let finish!: (error: string | null) => void;
  options.onRenamePartition.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(PartitionSidebar, { props: options });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  await user.type(screen.getByRole("textbox", { name: "Partition name" }), "Inbox{Enter}");
  await user.click(screen.getByRole("button", { name: "Rename Other" }));
  finish(null);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Partition name" })).toHaveValue("Other"),
  );
  expect(screen.getByRole("textbox", { name: "Partition name" })).toHaveFocus();
});
it("keeps focus on the destination when editing is cancelled by a click elsewhere", async () => {
  const user = userEvent.setup();
  render(PartitionSidebar, { props: props() });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  await user.click(screen.getByRole("button", { name: "All cards" }));
  expect(screen.getByRole("button", { name: "All cards" })).toHaveFocus();
  expect(screen.queryByRole("textbox", { name: "Partition name" })).not.toBeInTheDocument();
});
it("does not steal focus when a pending save finishes after clicking elsewhere", async () => {
  const user = userEvent.setup();
  const options = props();
  let finish!: (error: string | null) => void;
  options.onRenamePartition.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(PartitionSidebar, { props: options });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  await user.type(screen.getByRole("textbox", { name: "Partition name" }), "Inbox{Enter}");
  const destination = screen.getByRole("button", { name: "All cards" });
  await user.click(destination);
  expect(destination).toHaveFocus();
  finish(null);
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Partition name" })).not.toBeInTheDocument(),
  );
  expect(destination).toHaveFocus();
});
