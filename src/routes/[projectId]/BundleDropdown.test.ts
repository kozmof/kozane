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
    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("calls onChange with selected bundle id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(BundleDropdown, { props: makeProps({ onChange }) });
    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));
    expect(onChange).toHaveBeenCalledWith("b2");
  });

  it("closes the popover after selection", async () => {
    const user = userEvent.setup();
    render(BundleDropdown, { props: makeProps() });
    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });

  it("closes the popover on outside click", async () => {
    const user = userEvent.setup();
    render(BundleDropdown, { props: makeProps() });

    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    await user.click(document.body);

    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });

  it("marks the active bundle as selected", async () => {
    const user = userEvent.setup();
    render(BundleDropdown, { props: makeProps() });

    await user.click(screen.getByRole("button", { name: "Select bundle" }));

    expect(screen.getByRole("option", { name: /General/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Research/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("falls back to the first bundle when bundleId is unknown", () => {
    render(BundleDropdown, { props: makeProps({ bundleId: "missing" }) });
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("still calls onChange and closes when selecting the active bundle", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(BundleDropdown, { props: makeProps({ onChange }) });

    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    await user.click(screen.getByRole("option", { name: /General/ }));

    expect(onChange).toHaveBeenCalledWith("b1");
    expect(screen.queryByRole("listbox", { name: "Bundles" })).not.toBeInTheDocument();
  });
});
