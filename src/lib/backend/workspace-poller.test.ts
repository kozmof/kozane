import { afterEach, expect, it, vi } from "vitest";
import { WorkspacePoller } from "./workspace-poller";
afterEach(() => vi.useRealTimers());
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
function fixture() {
  let visible = true,
    refresh = () => {};
  const stop = vi.fn();
  const token = vi.fn().mockResolvedValue("same"),
    changed = vi.fn(),
    filesystemRefresh = vi.fn();
  let wait = 0;
  const poller = new WorkspacePoller({
    lifecycle: {
      visible: () => visible,
      listen: (listener) => {
        refresh = listener;
        return stop;
      },
    },
    token,
    changed,
    filesystemRefresh,
    throttleMs: () => wait,
  });
  return {
    poller,
    token,
    changed,
    filesystemRefresh,
    stop,
    setVisible: (value: boolean) => {
      visible = value;
      refresh();
    },
    focus: () => refresh(),
    throttle: (value: number) => {
      wait = value;
    },
  };
}
it("invalidates on the first successful baseline and refreshes filesystem views on unchanged polls", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const release = f.poller.retain();
  await flush();
  expect(f.changed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.filesystemRefresh).toHaveBeenCalledOnce();
  release();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("stops while hidden, refreshes on visibility/focus and shares subscriptions", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const first = f.poller.retain(),
    second = f.poller.retain();
  await flush();
  expect(f.token).toHaveBeenCalledOnce();
  f.setVisible(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.token).toHaveBeenCalledOnce();
  f.setVisible(true);
  await flush();
  expect(f.token).toHaveBeenCalledTimes(2);
  first();
  expect(f.stop).not.toHaveBeenCalled();
  second();
  second();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("rejects late replies from stopped sessions and creates a fresh baseline on resubscribe", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (token: string) => void;
  f.token.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const release = f.poller.retain();
  release();
  finish("old");
  await flush();
  expect(f.changed).not.toHaveBeenCalled();
  const again = f.poller.retain();
  await flush();
  expect(f.changed).toHaveBeenCalledOnce();
  again();
});
it("coalesces focus during an in-flight request and obeys a throttle deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (token: string) => void;
  f.token.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const release = f.poller.retain();
  f.focus();
  f.focus();
  expect(f.token).toHaveBeenCalledOnce();
  f.throttle(2000);
  finish("same");
  await flush();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.token).toHaveBeenCalledOnce();
  f.throttle(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.token).toHaveBeenCalledTimes(2);
  release();
});
it("retains an unset baseline after polling failure", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.token.mockRejectedValueOnce(new Error("offline"));
  const release = f.poller.retain();
  await flush();
  expect(f.changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.changed).toHaveBeenCalledOnce();
  release();
});
