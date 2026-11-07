import { expect, it, vi } from "vitest";
import { runNodeTransaction } from "./transaction";
import { ConflictError, UnavailableError } from "../../services/errors";

it("rolls back a failed commit before reporting its normalized error", async () => {
  const events: string[] = [];
  const cause = Object.assign(new Error("commit details"), {
    extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
  });
  const invalid = vi.fn();
  const result = runNodeTransaction(
    async () => ({
      handle: 42,
      commit: async () => {
        events.push("commit");
        throw cause;
      },
      rollback: async () => {
        events.push("rollback");
      },
      close: () => {
        events.push("close");
      },
    }),
    async (handle) => handle,
    invalid,
  );
  await expect(result).rejects.toBeInstanceOf(ConflictError);
  expect(events).toEqual(["commit", "rollback", "close"]);
  expect(invalid).not.toHaveBeenCalled();
});
it("invalidates before exposing rollback failure and retains both causes", async () => {
  const failure = new Error("operation");
  const rollback = new Error("rollback");
  const invalid = vi.fn();
  const close = vi.fn();
  const result = runNodeTransaction(
    async () => ({
      handle: 42,
      commit: async () => {},
      rollback: async () => {
        throw rollback;
      },
      close,
    }),
    async () => {
      throw failure;
    },
    invalid,
  );
  await expect(result).rejects.toMatchObject({
    name: "UnavailableError",
    cause: expect.any(AggregateError),
  });
  expect(invalid).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it("normalizes failures to start a transaction", async () => {
  await expect(
    runNodeTransaction(
      async () => {
        throw new Error("driver");
      },
      async () => 42,
      vi.fn(),
    ),
  ).rejects.toBeInstanceOf(UnavailableError);
});
