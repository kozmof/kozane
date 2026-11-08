import { afterEach, expect, it, vi } from "vitest";
import { deadline } from "../../../../scripts/restoration-harness/deadline.js";

afterEach(() => vi.useRealTimers());
it("clears the timer after success", async () => {
  vi.useFakeTimers();
  await expect(deadline(Promise.resolve(42), 100)).resolves.toBe(42);
  expect(vi.getTimerCount()).toBe(0);
});
it("times out, cleans up once and ignores late completion", async () => {
  vi.useFakeTimers();
  const cleanup = vi.fn();
  let resolve!: (value: number) => void;
  const promise = deadline(
    new Promise<number>((done) => {
      resolve = done;
    }),
    100,
    cleanup,
  );
  const rejected = expect(promise).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  resolve(42);
  await vi.advanceTimersByTimeAsync(100);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
