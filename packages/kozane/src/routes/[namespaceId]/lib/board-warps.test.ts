import { expect, it, vi } from "vitest";
import { BoardWarps } from "../../../../../client/src/board/lib/board-warps.svelte.js";
import { NamespaceState } from "../../../../../client/src/board/namespace-state.svelte.js";
import { data } from "../page.fixtures.js";
import { ClientError } from "../../../../../client/src/client/contract.js";
import { createDemoNavigation } from "../../../../../client/src/navigation.js";

function setup(readonly = false) {
  const s = new NamespaceState();
  s.resetFromData(data);
  const client = { warpDirectory: { get: vi.fn() }, warps: { remove: vi.fn() } };
  const removeWarp = vi.fn();
  const navigate = vi.fn().mockResolvedValue(undefined);
  const warps = new BoardWarps(
    {
      s,
      client,
      readonly,
      removeWarp,
      canvas: vi.fn(),
      navigation: () => createDemoNavigation({ base: "/demo" }),
      navigate,
    },
    { visible: true, directory: data.warpDirectory },
  );
  return { s, client, warps, removeWarp, navigate };
}

it("keeps the newest directory and rejects malformed refreshes", async () => {
  const { client, warps } = setup();
  let finish!: (value: typeof data.warpDirectory) => void;
  client.warpDirectory.get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{}]);
  const old = warps.refreshDirectory();
  await warps.refreshDirectory();
  finish(data.warpDirectory);
  await old;
  expect(warps.directory).toEqual([]);
  await warps.refreshDirectory();
  expect(warps.directory).toEqual([]);
});

it("tracks cross-namespace removal and restores rejected optimistic changes", async () => {
  const { s, client, warps } = setup();
  const entry = data.warpDirectory[0];
  let reject!: (error: unknown) => void;
  client.warps.remove.mockImplementation(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const pending = warps.remove(entry);
  expect(s.mutations.idle).toBe(false);
  expect(warps.directory).not.toContainEqual(entry);
  expect(client.warps.remove).toHaveBeenCalledWith(entry.namespaceId, entry.id);
  reject(new ClientError("conflict", "Warp changed"));
  await pending;
  expect(warps.directory).toEqual(data.warpDirectory);
  expect(s.lastError).toBe("Warp changed");
  expect(s.mutations.idle).toBe(true);
});

it("does not read or mutate in a static export", async () => {
  const { client, warps, removeWarp } = setup(true);
  await warps.refreshDirectory();
  await warps.remove(data.warpDirectory[0]);
  expect(client.warpDirectory.get).not.toHaveBeenCalled();
  expect(client.warps.remove).not.toHaveBeenCalled();
  expect(removeWarp).not.toHaveBeenCalled();
});

it("uses supplied navigation for cross-namespace warp jumps", () => {
  const { warps, navigate } = setup();
  warps.jump(data.warpDirectory[0]);
  expect(navigate).toHaveBeenCalledWith("/demo/board/?namespaceId=namespace-2&warp=warp-9");
});
