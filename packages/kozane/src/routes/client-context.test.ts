import { render, screen } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedClient } from "@kozane/client";
import Harness from "../test-utils/ClientSessionLayoutHarness.svelte";
const transition = (persisted: boolean) => Object.assign(new Event("pagehide"), { persisted });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("the root layout retains one client and one poll through route remounts and BFCache", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(Response.json({ token: "one" }));
  vi.stubGlobal("fetch", fetcher);
  const clients: ManagedClient[] = [];
  const observe = (client: ManagedClient) => clients.push(client);
  const page = render(Harness, { route: "board", observe });
  await page.rerender({ route: "tags", observe });
  expect(screen.getByText("tags")).toBeTruthy();
  expect(clients).toHaveLength(2);
  expect(clients[1]).toBe(clients[0]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetcher).toHaveBeenCalledOnce();
  window.dispatchEvent(transition(true));
  expect(clients[0].state.status).toBe("ready");
  await page.rerender({ route: "map", observe });
  expect(clients[2]).toBe(clients[0]);
  await page.unmount();
  expect(clients[0].state.status).toBe("unavailable");
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetcher).toHaveBeenCalledOnce();
});
it("separate roots have independent owners, and document discard disposes them", () => {
  const a: ManagedClient[] = [],
    b: ManagedClient[] = [];
  const first = render(Harness, { route: "first", observe: (client) => a.push(client) });
  render(Harness, { route: "second", observe: (client) => b.push(client) });
  expect(a[0]).not.toBe(b[0]);
  first.unmount();
  expect(a[0].state.status).toBe("unavailable");
  expect(b[0].state.status).toBe("ready");
  window.dispatchEvent(transition(false));
  expect(b[0].state.status).toBe("unavailable");
});
