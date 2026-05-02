import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import BundleDropdown from "./BundleDropdown.svelte";

const bundles = [
  { id: "b1", name: "General", bg: "#fff7ed", dot: "#f59e0b" },
  { id: "b2", name: "Research", bg: "#f0fdf4", dot: "#22c55e" },
];

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    bundles,
    bundleId: "b1",
    onChange: vi.fn(),
    ...overrides,
  };
}

describe("BundleDropdown", () => {
  it("renders the active bundle name", () => {
    render(BundleDropdown, { props: makeProps() });
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("popover is hidden initially", () => {
    render(BundleDropdown, { props: makeProps() });
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });

  it("opens the popover on trigger click", async () => {
    const user = userEvent.setup();
    render(BundleDropdown, { props: makeProps() });
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("calls onChange with selected bundle id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(BundleDropdown, { props: makeProps({ onChange }) });
    await user.click(screen.getByRole("button"));
    // Find and click the Research option in the popover
    const options = screen.getAllByRole("button");
    const researchOption = options.find((b) => b.textContent?.includes("Research"));
    await user.click(researchOption!);
    expect(onChange).toHaveBeenCalledWith("b2");
  });

  it("closes the popover after selection", async () => {
    const user = userEvent.setup();
    render(BundleDropdown, { props: makeProps() });
    await user.click(screen.getByRole("button"));
    const options = screen.getAllByRole("button");
    const researchOption = options.find((b) => b.textContent?.includes("Research"));
    await user.click(researchOption!);
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });
});
