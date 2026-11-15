/** SQLite pragma results are small integers, regardless of the driver's integer mode. */
export type ConnectionExecutor = (
  statement: string,
) => Promise<readonly { readonly [index: number]: unknown }[]>;
const requiredPragmas = ["foreign_keys", "recursive_triggers"] as const;
export class ActionConnectionError extends Error {
  override readonly name = "ActionConnectionError";
  readonly code = "action-connection-required";
  constructor(
    readonly pragma: (typeof requiredPragmas)[number],
    readonly observed: unknown,
  ) {
    super(`Action writes require PRAGMA ${pragma}=ON; connection reported ${String(observed)}`);
  }
}

/** Verify without changing the connection. Use again before publishing a completed root. */
export async function verifyActionConnection(execute: ConnectionExecutor): Promise<void> {
  for (const pragma of requiredPragmas) {
    const rows = await execute(`PRAGMA ${pragma}`);
    const value = rows[0]?.[0];
    if (Number(value) !== 1) throw new ActionConnectionError(pragma, value);
  }
}

/** Set and read back both flags. SQLite cannot enable foreign keys inside an already-open transaction. */
export async function configureActionConnection(execute: ConnectionExecutor): Promise<void> {
  for (const pragma of requiredPragmas) await execute(`PRAGMA ${pragma}=ON`);
  await verifyActionConnection(execute);
}
