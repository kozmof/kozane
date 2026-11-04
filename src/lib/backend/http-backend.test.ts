import { expect, it, vi } from "vitest";
import { HttpBackend } from "./http-backend";
const capabilities = {
  writable: true,
  persistent: true,
  externalWrites: true,
  taskspaces: true,
  auth: false,
};
it("routes opaque card IDs and publishes current stamps after successful mutation", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
  const backend = new HttpBackend({ fetcher, base: "/base", capabilities });
  const observed = vi.fn();
  backend.subscribe((event) => {
    expect(backend.version.revision).toBe(event.revision);
    observed(event);
  });
  await backend.cards.update("ns /x", "card /y", { content: "edited" }, { keepalive: true });
  expect(fetcher.mock.calls[0][0]).toBe("/base/ns%20%2Fx/api/cards/card%20%2Fy");
  expect(fetcher.mock.calls[0][1].method).toBe("PATCH");
  expect(observed).toHaveBeenCalledOnce();
  expect(observed.mock.calls[0][0].namespaceIds).toBeUndefined();
});
it("publishes nothing on rejected mutations and enforces read-only capabilities", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response('{"message":"invalid"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
  const backend = new HttpBackend({ fetcher, capabilities });
  const listener = vi.fn();
  backend.subscribe(listener);
  await expect(backend.cards.create("ns", { content: NaN })).rejects.toMatchObject({
    code: "validation",
  });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(backend.cards.create("ns", { content: "x" })).rejects.toMatchObject({
    code: "validation",
  });
  expect(listener).not.toHaveBeenCalled();
  const readonly = new HttpBackend({ fetcher, capabilities: { ...capabilities, writable: false } });
  await expect(readonly.namespaces.create({ name: "new" })).rejects.toMatchObject({
    code: "read_only",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
