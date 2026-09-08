import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import PartitionDropdown from "./PartitionDropdown.svelte";

const partitions = [
  { id: "b1", name: "General", bg: "#fff7ed", dot: "#f59e0b", isDefault: true },
  { id: "b2", name: "Research", bg: "#f0fdf4", dot: "#22c55e", isDefault: false },
];

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    partitions,
    partitionId: "b1",
    onChange: vi.fn(),
    ...overrides,
  };
}

describe("PartitionDropdown", () => {
  it("renders the active partition name", () => {
    render(PartitionDropdown, { props: makeProps() });
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("popover is hidden initially", () => {
    render(PartitionDropdown, { props: makeProps() });
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });

  it("opens the popover on trigger click", async () => {
    const user = userEvent.setup();
    render(PartitionDropdown, { props: makeProps() });
    await user.click(screen.getByRole("button", { name: "Select partition" }));
    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("calls onChange with selected partition id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(PartitionDropdown, { props: makeProps({ onChange }) });
    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));
    expect(onChange).toHaveBeenCalledWith("b2");
  });

  it("closes the popover after selection", async () => {
    const user = userEvent.setup();
    render(PartitionDropdown, { props: makeProps() });
    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });

  it("closes the popover on outside click", async () => {
    const user = userEvent.setup();
    render(PartitionDropdown, { props: makeProps() });

    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(document.body);

    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });

  it("marks the active partition as selected", async () => {
    const user = userEvent.setup();
    render(PartitionDropdown, { props: makeProps() });

    await user.click(screen.getByRole("button", { name: "Select partition" }));

    expect(screen.getByRole("option", { name: /General/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Research/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("falls back to the first partition when partitionId is unknown", () => {
    render(PartitionDropdown, { props: makeProps({ partitionId: "missing" }) });
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("still calls onChange and closes when selecting the active partition", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(PartitionDropdown, { props: makeProps({ onChange }) });

    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(screen.getByRole("option", { name: /General/ }));

    expect(onChange).toHaveBeenCalledWith("b1");
    expect(screen.queryByRole("listbox", { name: "Partitions" })).not.toBeInTheDocument();
  });
});
