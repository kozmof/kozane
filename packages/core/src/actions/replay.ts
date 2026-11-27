import { sql } from "drizzle-orm";
import { withTx, type DB, type Tx } from "../database.js";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
import {
  ActionExecutionError,
  runActionGroupAtBoundary,
  type ActionGroupOptions,
  type ActionGroupResult,
} from "./execution.js";

export interface ActionReplaySession {
  /** Trusted orchestration may update reconciliation state between awaited roots. */
  readonly db: Tx;
  replay<Inputs extends object, C>(
    options: ActionGroupOptions<Inputs, C>,
  ): Promise<ActionGroupResult>;
}

export class ActionReplayCleanupError extends Error {
  override readonly name = "ActionReplayCleanupError";
  readonly code = "action-replay-cleanup";
  constructor(
    cause: unknown,
    readonly cleanupFailure: unknown,
  ) {
    super("Replay savepoint cleanup failed; the outer transaction must roll back", { cause });
  }
}

/** Internal opt-in reconciliation boundary. No retries, failure classification or durable outcomes. */
export function withActionReplayTransaction<T>(
  db: DB,
  operation: (session: ActionReplaySession) => Promise<T>,
): Promise<T> {
  return withTx(db, async (tx) => {
    const executeConnection = (statement: string) => tx.values(sql.raw(statement));
    await configureActionConnection(executeConnection);
    let open = true;
    let failed = false;
    let firstFailure: unknown;
    let ordinal = 0;
    let pending: Promise<void> | null = null;
    const fail = (cause: unknown) => {
      if (!failed) {
        failed = true;
        firstFailure = cause;
      }
      return firstFailure;
    };
    const check = () => {
      if (failed) throw firstFailure;
    };
    async function savepoint(
      execute: (tx: Tx) => Promise<ActionGroupResult>,
    ): Promise<ActionGroupResult> {
      const name = `kozane_action_replay_${++ordinal}`;
      try {
        await tx.run(sql.raw(`SAVEPOINT ${name}`));
      } catch (cause) {
        throw fail(cause);
      }
      try {
        const result = await execute(tx);
        check();
        try {
          await tx.run(sql.raw(`RELEASE SAVEPOINT ${name}`));
        } catch (cause) {
          throw fail(cause);
        }
        return result;
      } catch (cause) {
        try {
          await tx.run(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
          await tx.run(sql.raw(`RELEASE SAVEPOINT ${name}`));
        } catch (cleanupFailure) {
          throw fail(new ActionReplayCleanupError(cause, cleanupFailure));
        }
        throw cause;
      }
    }
    const session: ActionReplaySession = Object.freeze({
      db: tx,
      replay<Inputs extends object, C>(options: ActionGroupOptions<Inputs, C>) {
        let promise: Promise<ActionGroupResult>;
        try {
          if (!open) throw new ActionExecutionError("Replay transaction has closed");
          check();
          if (pending) throw fail(new ActionExecutionError("Replay roots must run sequentially"));
          if (options.bindings.mode !== "replay")
            throw new ActionExecutionError("Replay savepoints require recorded bindings");
          promise = runActionGroupAtBoundary(options, savepoint);
          const settled = promise.then(
            () => {
              pending = null;
            },
            () => {
              pending = null;
            },
          );
          pending = settled;
        } catch (cause) {
          promise = Promise.reject(cause);
        }
        // Observe ignored failures while still returning the original rejection to callers.
        void promise.catch(() => {});
        return promise;
      },
    });
    let result: T | undefined;
    try {
      result = await operation(session);
    } catch (cause) {
      fail(cause);
    }
    open = false;
    if (pending) {
      fail(new ActionExecutionError("Replay transaction returned with an outstanding root"));
      await pending;
    }
    check();
    await verifyActionConnection(executeConnection);
    check();
    return result as T;
  });
}
