import { expect, it, vi } from "vitest";
import {
  ActionConnectionError,
  configureActionConnection,
  verifyActionConnection,
  type ConnectionExecutor,
} from "../../../core/src/actions/connection.js";

it("configures and reads back both flags across raw driver row shapes", async () => {
  const flags = { foreign_keys: 0, recursive_triggers: 0 };
  const execute: ConnectionExecutor = async (statement) => {
    if (statement === "PRAGMA foreign_keys=ON") flags.foreign_keys = 1;
    if (statement === "PRAGMA recursive_triggers=ON") flags.recursive_triggers = 1;
    if (statement === "PRAGMA foreign_keys") return [{ 0: BigInt(flags.foreign_keys) }];
    if (statement === "PRAGMA recursive_triggers") return [[String(flags.recursive_triggers)]];
    return [];
  };
  await configureActionConnection(execute);
  expect(flags).toEqual({ foreign_keys: 1, recursive_triggers: 1 });
});

it.each(["foreign_keys", "recursive_triggers"] as const)(
  "refuses a connection where %s cannot be enabled",
  async (pragma) => {
    const execute: ConnectionExecutor = async (statement) =>
      statement === `PRAGMA ${pragma}` ? [[0]] : statement.endsWith("=ON") ? [] : [[1]];
    await expect(configureActionConnection(execute)).rejects.toMatchObject({
      code: "action-connection-required",
      pragma,
      observed: 0,
    });
  },
);

it("verifies both flags after all settings have been applied", async () => {
  let foreign = 0;
  const execute: ConnectionExecutor = async (statement) => {
    if (statement === "PRAGMA foreign_keys=ON") foreign = 1;
    // Model a connection reset or a faulty adapter that loses the first setting.
    if (statement === "PRAGMA recursive_triggers=ON") foreign = 0;
    return statement === "PRAGMA foreign_keys" ? [[foreign]] : [[1]];
  };
  await expect(configureActionConnection(execute)).rejects.toBeInstanceOf(ActionConnectionError);
});

it("does not change flags during verification and rejects missing pragma results", async () => {
  const execute = vi.fn<ConnectionExecutor>(async () => []);
  await expect(verifyActionConnection(execute)).rejects.toMatchObject({
    pragma: "foreign_keys",
    observed: undefined,
  });
  expect(execute.mock.calls.every(([statement]) => !statement.includes("="))).toBe(true);
});

it("preserves infrastructure failures without retrying statements", async () => {
  const failure = new Error("connection closed");
  const execute = vi.fn<ConnectionExecutor>(async () => {
    throw failure;
  });
  await expect(configureActionConnection(execute)).rejects.toBe(failure);
  expect(execute).toHaveBeenCalledOnce();
});
