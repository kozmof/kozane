import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { BackendSignals } from "../../../src/lib/backend/signals.js";
import { BackendError } from "../../../src/lib/backend/contract.js";
import RefreshNotice from "./RefreshNotice.svelte";
it("reports transient polling errors without changing readiness and rejects old-backend updates", async () => {
  const first = new BackendSignals({ status: "ready" });
  const second = new BackendSignals({ status: "ready" });
  const retry = vi.fn();
  const props = { message: "Could not refresh data.", retry };
  const view = render(RefreshNotice, { props: { ...props, backend: first } });
  first.transition({
    status: "ready",
    refreshError: new BackendError("unavailable", "Metadata unavailable"),
  });
  expect(await screen.findByRole("status")).toHaveTextContent("Could not check workspace changes");
  expect(first.state.status).toBe("ready");
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
  first.transition({ status: "ready" });
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  await view.rerender({ ...props, backend: second });
  first.transition({ status: "ready", refreshError: new BackendError("network", "Old backend") });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await view.rerender({ ...props, backend: second, failed: true });
  expect(screen.getByRole("status")).toHaveTextContent("Could not refresh data.");
});
