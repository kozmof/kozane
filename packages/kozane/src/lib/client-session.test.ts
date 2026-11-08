import { expect, it, vi } from "vitest";
import { WorkspaceClientSession } from "./client-session.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: true,
  auth: false,
};
const data = { clientCapabilities: capabilities };
it("shares one HTTP client across route data and closes it only with its owner", async () => {
  const session = new WorkspaceClientSession({ base: "/root", fetcher: vi.fn() });
  const first = session.select(data)!;
  expect(session.select({ clientCapabilities: { ...capabilities } })).toBe(first);
  expect(first.state.status).toBe("ready");
  session.dispose();
  session.dispose();
  expect(first.state.status).toBe("unavailable");
  await expect(first.namespaces.list()).rejects.toMatchObject({ code: "unavailable" });
  expect(() => session.select(data)).toThrow("disposed");
});
it("does not share clients between independent SSR request owners", () => {
  const a = new WorkspaceClientSession({ base: "" });
  const b = new WorkspaceClientSession({ base: "" });
  const first = a.select(data)!;
  const second = b.select(data)!;
  expect(first).not.toBe(second);
  a.dispose();
  expect(second.state.status).toBe("ready");
  b.dispose();
});
it("replaces clients on capability changes and keeps static exports scoped to supplied page data", async () => {
  const session = new WorkspaceClientSession({ base: "" });
  const first = session.select(data)!;
  const second = session.select({ clientCapabilities: { ...capabilities, writable: false } })!;
  expect(second).not.toBe(first);
  expect(first.state.status).toBe("unavailable");
  const source = { staticClientData: { namespaces: [{ id: "a", name: "A", isDefault: true }] } };
  const third = session.select(source)!;
  expect(session.select(source)).toBe(third);
  expect(second.state.status).toBe("unavailable");
  const fourth = session.select({
    staticClientData: { namespaces: [{ id: "b", name: "B", isDefault: false }] },
  })!;
  expect(await fourth.namespaces.list()).toEqual([{ id: "b", name: "B", isDefault: false }]);
  await expect(fourth.namespaces.get("a")).rejects.toMatchObject({ code: "not_found" });
  expect(third.state.status).toBe("unavailable");
  session.dispose();
});
it("keeps an existing session when replacement data is invalid", () => {
  const session = new WorkspaceClientSession({ base: "" });
  const first = session.select(data)!;
  expect(() => session.select({ staticClientData: { namespaces: null as never } })).toThrow();
  expect(session.select(data)).toBe(first);
  expect(first.state.status).toBe("ready");
  session.dispose();
});

it("does not trust old page seeds when a shared connection is reused, including browser back", () => {
  const session = new WorkspaceClientSession({ base: "" });
  const firstPage = { clientCapabilities: { ...capabilities } };
  const secondPage = { clientCapabilities: { ...capabilities } };
  const client = session.select(firstPage)!;
  expect(session.trustsInitialSeed(firstPage)).toBe(true);
  expect(session.select(secondPage)).toBe(client);
  expect(session.trustsInitialSeed(secondPage)).toBe(false);
  expect(session.select(firstPage)).toBe(client);
  expect(session.trustsInitialSeed(firstPage)).toBe(false);
  session.dispose();
});

it("cannot activate a replacement after an old client's listener disposes its owner", () => {
  const session = new WorkspaceClientSession({ base: "" });
  const client = session.select(data)!;
  client.subscribeState((state) => {
    if (state.status === "unavailable") session.dispose();
  });
  expect(() =>
    session.select({ clientCapabilities: { ...capabilities, writable: false } }),
  ).toThrow("disposed");
  expect(client.state.status).toBe("unavailable");
  expect(() => session.select(data)).toThrow("disposed");
});

it("reuses equivalent static data but replaces changed content", async () => {
  const session = new WorkspaceClientSession({ base: "" });
  const snapshot = { namespaces: [{ id: "a", name: "A", isDefault: true }] };
  const first = session.select({ staticClientData: snapshot })!;
  expect(session.select({ staticClientData: structuredClone(snapshot) })).toBe(first);
  snapshot.namespaces[0].name = "Updated";
  const next = session.select({ staticClientData: snapshot })!;
  expect(next).not.toBe(first);
  expect((await next.namespaces.list())[0].name).toBe("Updated");
  session.dispose();
});
it("prefers embedded data over capabilities and limits readonly fallback", () => {
  const session = new WorkspaceClientSession({ base: "" });
  const fallback = vi.fn(() => ({ namespaces: [] }));
  expect(session.select({})).toBeUndefined();
  expect(session.select({ readonly: true }, fallback).kind).toBe("static");
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(session.select({ readonly: true, clientCapabilities: capabilities }, fallback).kind).toBe(
    "http",
  );
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(
    session.select({ clientCapabilities: capabilities, staticClientData: { namespaces: [] } })!
      .kind,
  ).toBe("static");
  session.dispose();
});
