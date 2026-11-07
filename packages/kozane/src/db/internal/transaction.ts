import { classifyLibsqlFailure } from "./classify-failure.js";
import { normalizeDatabaseFailure } from "../failures.js";

export interface TransactionLifecycle<Handle> {
  handle: Handle;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
}

/** Own cleanup before publishing a failure. A failed rollback invalidates the connection. */
export async function runNodeTransaction<Handle, Result>(
  begin: () => Promise<TransactionLifecycle<Handle>>,
  operation: (handle: Handle) => Promise<Result>,
  invalidate: () => void,
): Promise<Result> {
  let transaction: TransactionLifecycle<Handle>;
  try {
    transaction = await begin();
  } catch (cause) {
    throw normalizeDatabaseFailure(cause, classifyLibsqlFailure(cause));
  }
  let committing = false;
  try {
    const result = await operation(transaction.handle);
    committing = true;
    await transaction.commit();
    return result;
  } catch (cause) {
    try {
      await transaction.rollback();
    } catch (rollbackCause) {
      invalidate();
      throw normalizeDatabaseFailure(cause, classifyLibsqlFailure(cause), { cause: rollbackCause });
    }
    const failure = classifyLibsqlFailure(cause);
    // Preserve adapter/application errors during extraction. Driver errors normalize only
    // after rollback; commit failures always normalize, including unknown driver failures.
    if (committing || failure.kind !== "unknown" || failure.constraint !== "other")
      throw normalizeDatabaseFailure(cause, failure);
    throw cause;
  } finally {
    transaction.close();
  }
}
