import { expect, it, vi } from "vitest";
import { HttpClient } from "../../src/backend/http-client.js";
import { StaticClient } from "../../src/backend/static-client.js";
const capabilities = {
  writable: true,
  persistent: true,
  externalWrites: false,
  taskspaces: true,
  auth: false,
};
it("disposal aborts reads, stops polling and publishes unavailable exactly once", async () => {
  let signal: AbortSignal | undefined;
  const stop = vi.fn();
  const fetcher = vi.fn(
    (_url: unknown, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = options?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      }),
  );
  const client = new HttpClient({
    fetcher: fetcher as typeof fetch,
    capabilities: { ...capabilities, externalWrites: true },
    lifecycle: { visible: () => true, listen: () => stop },
  });
  const release = client.subscribe(() => {});
  const states: string[] = [];
  client.subscribeState((state) => states.push(state.status));
  client.dispose();
  client.dispose();
  release();
  expect(signal?.aborted).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
  expect(states).toEqual(["ready", "unavailable"]);
  await expect(client.namespaces.list()).rejects.toMatchObject({ code: "unavailable" });
  await expect(client.namespaces.create({ name: "closed" })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
it("does not abort or replay a dispatched mutation when its owner is disposed", async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const client = new HttpClient({ fetcher, capabilities });
  const invalidated = vi.fn();
  client.subscribe(invalidated);
  const mutation = client.namespaces.create({ name: "committed" });
  client.dispose();
  complete(Response.json({ id: "new", name: "committed", isDefault: false }));
  await expect(mutation).resolves.toMatchObject({ id: "new" });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(invalidated).not.toHaveBeenCalled();
});
it("static clients release subscriptions and reject subsequent operations", async () => {
  const client = new StaticClient({ namespaces: [] });
  const observed = vi.fn();
  client.subscribeState(observed);
  client.dispose();
  client.dispose();
  expect(observed).toHaveBeenCalledTimes(2);
  expect(client.state.status).toBe("unavailable");
  await expect(client.namespaces.list()).rejects.toMatchObject({ code: "unavailable" });
  await expect(client.namespaces.create({ name: "closed" })).rejects.toMatchObject({
    code: "unavailable",
  });
});
