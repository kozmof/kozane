import { expect, it, vi } from "vitest";
import { bindViewWrites } from "./view-writes.js";
import { BackendSignals } from "../../../backend/signals.js";
import { StaticBackend } from "../../../backend/static-backend.js";
import { HttpBackend } from "../../../backend/http-backend.js";
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
  const backend = new HttpBackend({ capabilities, fetcher });
  let ready = true;
  const view = bindViewWrites(backend, () => ready);
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
  const backend = new HttpBackend({ capabilities, fetcher });
  const signals = new BackendSignals({ status: "ready" });
  vi.spyOn(backend, "version", "get").mockImplementation(() => signals.version);
  const view = bindViewWrites(backend, () => true);
  const update = view.cards.update;
  signals.publish(["snapshot"], undefined, true);
  await expect(update("n", "c", { content: "Old intent" })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("leaves read methods and adapter lifecycle methods available while writes are paused", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
  const backend = new HttpBackend({ capabilities, fetcher });
  const view = bindViewWrites(backend, () => false);
  expect(await view.namespaces.list()).toEqual([]);
  expect(view.state).toBe(backend.state);
  const stop = view.subscribeState(() => {});
  stop();
  expect(view.taskspaces).toBeUndefined();
});
it("supports frozen adapters and keeps read-only error precedence", async () => {
  const backend = Object.freeze(new StaticBackend({ namespaces: [] }));
  const view = bindViewWrites(backend, () => false);
  expect(await view.namespaces.list()).toEqual([]);
  await expect(view.namespaces.create({ name: "Notes" })).rejects.toMatchObject({
    code: "read_only",
  });
});
