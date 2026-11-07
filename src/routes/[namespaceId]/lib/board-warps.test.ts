import { expect, it, vi } from "vitest";
import { BoardWarps } from "../../../../packages/client/src/board/lib/board-warps.svelte.js";
import { NamespaceState } from "../../../../packages/client/src/board/namespace-state.svelte.js";
import { data } from "../page.fixtures.js";
import { BackendError } from "$lib/backend/contract.js";
import { createDemoNavigation } from "$lib/navigation.js";

function setup(readonly = false) {
  const s = new NamespaceState();
  s.resetFromData(data);
  const backend = { warpDirectory: { get: vi.fn() }, warps: { remove: vi.fn() } };
  const removeWarp = vi.fn();
  const navigate = vi.fn().mockResolvedValue(undefined);
  const warps = new BoardWarps(
    {
      s,
      backend,
      readonly,
      removeWarp,
      canvas: vi.fn(),
      navigation: () => createDemoNavigation({ base: "/demo" }),
      navigate,
    },
    { visible: true, directory: data.warpDirectory },
  );
  return { s, backend, warps, removeWarp, navigate };
}

it("keeps the newest directory and rejects malformed refreshes", async () => {
  const { backend, warps } = setup();
  let finish!: (value: typeof data.warpDirectory) => void;
  backend.warpDirectory.get
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
  const { s, backend, warps } = setup();
  const entry = data.warpDirectory[0];
  let reject!: (error: unknown) => void;
  backend.warps.remove.mockImplementation(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const pending = warps.remove(entry);
  expect(s.mutations.idle).toBe(false);
  expect(warps.directory).not.toContainEqual(entry);
  expect(backend.warps.remove).toHaveBeenCalledWith(entry.namespaceId, entry.id);
  reject(new BackendError("conflict", "Warp changed"));
  await pending;
  expect(warps.directory).toEqual(data.warpDirectory);
  expect(s.lastError).toBe("Warp changed");
  expect(s.mutations.idle).toBe(true);
});

it("does not read or mutate in a static export", async () => {
  const { backend, warps, removeWarp } = setup(true);
  await warps.refreshDirectory();
  await warps.remove(data.warpDirectory[0]);
  expect(backend.warpDirectory.get).not.toHaveBeenCalled();
  expect(backend.warps.remove).not.toHaveBeenCalled();
  expect(removeWarp).not.toHaveBeenCalled();
});

it("uses supplied navigation for cross-namespace warp jumps", () => {
  const { warps, navigate } = setup();
  warps.jump(data.warpDirectory[0]);
  expect(navigate).toHaveBeenCalledWith("/demo/board/?namespaceId=namespace-2&warp=warp-9");
});
