import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import PartitionSidebar from "../../../../../client/src/board/components/PartitionSidebar.svelte";
const props = () => ({
  visible: true,
  namespacesHref: "/",
  panelWidth: 220,
  cards: [],
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
  await user.dblClick(screen.getByRole("button", { name: /^General/ }));
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
  await user.dblClick(screen.getByRole("button", { name: /^General/ }));
  await user.type(screen.getByRole("textbox", { name: "Partition name" }), "other{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Duplicate partition");
});
it("does not rename partitions in a read-only view", async () => {
  const user = userEvent.setup();
  render(PartitionSidebar, { props: { ...props(), readonly: true } });
  await user.dblClick(screen.getByRole("button", { name: /^General/ }));
  expect(screen.queryByRole("textbox", { name: "Partition name" })).not.toBeInTheDocument();
});

it("opens renaming from the edit icon beside the card count", async () => {
  const user = userEvent.setup();
  const options = props();
  render(PartitionSidebar, { props: options });
  await user.click(screen.getByRole("button", { name: "Rename General" }));
  expect(screen.getByRole("textbox", { name: "Partition name" })).toHaveValue("General");
});
