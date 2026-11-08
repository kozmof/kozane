import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { ClientSignals } from "../src/client/signals.js";
import { ClientError } from "../src/client/contract.js";
import RefreshNotice from "../src/RefreshNotice.svelte";
it("reports transient polling errors without changing readiness and rejects old-client updates", async () => {
  const first = new ClientSignals({ status: "ready" });
  const second = new ClientSignals({ status: "ready" });
  const retry = vi.fn();
  const props = { message: "Could not refresh data.", retry };
  const view = render(RefreshNotice, { props: { ...props, client: first } });
  first.transition({
    status: "ready",
    refreshError: new ClientError("unavailable", "Metadata unavailable"),
  });
  expect(await screen.findByRole("status")).toHaveTextContent("Could not check workspace changes");
  expect(first.state.status).toBe("ready");
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
  first.transition({ status: "ready" });
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  await view.rerender({ ...props, client: second });
  first.transition({ status: "ready", refreshError: new ClientError("network", "Old client") });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await view.rerender({ ...props, client: second, failed: true });
  expect(screen.getByRole("status")).toHaveTextContent("Could not refresh data.");
});
