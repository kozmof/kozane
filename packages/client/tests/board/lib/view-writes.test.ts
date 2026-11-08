import { expect, it, vi } from "vitest";
import { bindViewWrites } from "../../../src/board/lib/view-writes.js";
import { ClientSignals } from "../../../src/client/signals.js";
import { StaticClient } from "../../../src/client/static-client.js";
import { HttpClient } from "../../../src/client/http-client.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: false,
  externalWrites: false,
  auth: false,
};
it("checks every mutation dispatch, including methods captured before recovery", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ id: "n", name: "Notes", isDefault: false }));
  const client = new HttpClient({ capabilities, fetcher });
  let ready = true;
  const view = bindViewWrites(client, () => ready);
  const create = view.namespaces.create;
  await create({ name: "Notes" });
  ready = false;
  await expect(create({ name: "Paused" })).rejects.toMatchObject({ code: "unavailable" });
  expect(fetcher).toHaveBeenCalledOnce();
  ready = true;
  await create({ name: "Resumed" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("rejects a late continuation after generation replacement without dispatch", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = new HttpClient({ capabilities, fetcher });
  const signals = new ClientSignals({ status: "ready" });
  vi.spyOn(client, "version", "get").mockImplementation(() => signals.version);
  const view = bindViewWrites(client, () => true);
  const update = view.cards.update;
  signals.publish(["snapshot"], undefined, true);
  await expect(update("n", "c", { content: "Old intent" })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("leaves read methods and adapter lifecycle methods available while writes are paused", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
  const client = new HttpClient({ capabilities, fetcher });
  const view = bindViewWrites(client, () => false);
  expect(await view.namespaces.list()).toEqual([]);
  expect(view.state).toBe(client.state);
  const stop = view.subscribeState(() => {});
  stop();
  expect(view.taskspaces).toBeUndefined();
});
it("supports frozen adapters and keeps read-only error precedence", async () => {
  const client = Object.freeze(new StaticClient({ namespaces: [] }));
  const view = bindViewWrites(client, () => false);
  expect(await view.namespaces.list()).toEqual([]);
  await expect(view.namespaces.create({ name: "Notes" })).rejects.toMatchObject({
    code: "read_only",
  });
});
