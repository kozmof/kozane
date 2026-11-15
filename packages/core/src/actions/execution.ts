import { sql } from "drizzle-orm";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
import { bindActionServiceFrame } from "./service-frame.js";
import { withTx, type DB, type Tx } from "../database.js";
import { prepareInput } from "../services/prepare-input.js";
import { actionBindingPath, type ActionBindingMap, type ActionBindings } from "./bindings.js";
import { ActionContractRequiredError, type defineActionRegistry } from "./registry.js";

export class ActionExecutionError extends Error {
  override readonly name = "ActionExecutionError";
}
export interface ActionInvocation {
  readonly id: string;
  readonly kind: string;
  readonly contractVersion: number;
  readonly input: unknown;
}
export interface ActionExecutionRecord extends ActionInvocation {
  readonly parentId: string | null;
  readonly executionOrd: number;
  readonly generated: ActionBindingMap;
}
export interface ActionGroupResult {
  readonly result: unknown;
  readonly invocation: ActionInvocation;
  readonly generated: ActionBindingMap;
  readonly executions: readonly ActionExecutionRecord[];
}
export interface ActionChildResult {
  readonly id: string;
  readonly result: unknown;
}
export interface ActionFrameAccess {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly contractVersion: number;
  child(path: readonly string[], kind: string, input: unknown): Promise<unknown>;
  dispatch(
    path: readonly string[],
    kind: string,
    input: unknown,
    expectedId?: string,
  ): Promise<ActionChildResult>;
  check(): void;
  fail(cause: unknown): never;
}
interface Frame {
  readonly invocation: ActionInvocation;
  readonly parent: Frame | null;
  readonly path: readonly string[];
  readonly executionOrd: number;
  readonly generated: Map<string, ActionBindingMap[string]>;
  readonly pending: Set<Promise<void>>;
  readonly sql: Set<Promise<void>>;
  open: boolean;
  child: Promise<void> | null;
}
export function freezeActionInput(input: unknown): unknown {
  if (input !== null && typeof input === "object") {
    for (const value of Object.values(input)) freezeActionInput(value);
    Object.freeze(input);
  }
  return input;
}

/** Internal opt-in boundary. Persistence hooks may write only transaction-owned log/context rows. */
export async function runActionGroup<Inputs extends object, C>(options: {
  readonly db: DB;
  readonly schemaVersion: number;
  readonly registry: ReturnType<typeof defineActionRegistry<Inputs, C>>;
  readonly invocation: ActionInvocation;
  readonly bindings: ActionBindings;
  readonly createContext: (frame: ActionFrameAccess, db: Tx) => C;
  readonly enter?: (db: Tx, execution: Omit<ActionExecutionRecord, "generated">) => Promise<void>;
  readonly leave?: (db: Tx, actionId: string, parentId: string | null) => Promise<void>;
  readonly complete?: (db: Tx, group: ActionGroupResult) => Promise<void>;
}) {
  const { registry, bindings, db, schemaVersion, createContext, enter, leave, complete } = options;
  const invocation = Object.freeze({
    ...options.invocation,
    input: freezeActionInput(prepareInput(options.invocation.input)),
  });
  if (
    !registry.supportsSchema(schemaVersion) ||
    invocation.contractVersion !== registry.contractVersion
  )
    throw new ActionContractRequiredError(
      invocation.contractVersion,
      schemaVersion,
      registry.supportsSchema(schemaVersion) ? [registry.contractVersion] : [],
    );
  if (
    !invocation.id ||
    typeof invocation.id !== "string" ||
    !invocation.kind ||
    typeof invocation.kind !== "string"
  )
    throw new ActionExecutionError("Root action requires an ID and kind");
  return withTx(db, async (tx) => {
    const executeConnection = (statement: string) => tx.values(sql.raw(statement));
    await configureActionConnection(executeConnection);
    let failed = false;
    let firstFailure: unknown;
    let current: Frame | null = null;
    const frames: Frame[] = [];
    const ids = new Set([invocation.id]);
    const fail = (cause: unknown) => {
      if (!failed) {
        failed = true;
        firstFailure = cause;
      }
      return firstFailure;
    };
    const assertOwner = (frame: Frame) => {
      if (failed) throw firstFailure;
      if (!frame.open || current !== frame || frame.child)
        throw fail(new ActionExecutionError("Action handler does not own the execution frame"));
    };
    const observe = <T>(promise: Promise<T>, pending: Set<Promise<void>>) => {
      const settled = promise.then(
        () => {
          pending.delete(settled);
        },
        () => {
          pending.delete(settled);
        },
      );
      pending.add(settled);
      return promise;
    };
    const sqlCall = (frame: Frame, operation: () => unknown): Promise<unknown> => {
      assertOwner(frame);
      let promise: Promise<unknown>;
      try {
        promise = Promise.resolve(operation()).catch((cause: unknown) => {
          throw fail(cause);
        });
      } catch (cause) {
        throw fail(cause);
      }
      observe(promise, frame.sql);
      return observe(promise, frame.pending);
    };
    function guardedHandle(frame: Frame): Tx {
      const proxies = new WeakMap<object, object>();
      const executors = new Set(["run", "all", "get", "execute"]);
      const hidden = new Set(["session", "$client", "_", "dialect"]);
      function guard(target: object): object {
        const cached = proxies.get(target);
        if (cached) return cached;
        const proxy = new Proxy(target, {
          get(object, property) {
            if (hidden.has(String(property)) || property === "transaction")
              throw fail(
                new ActionExecutionError(
                  "Raw transaction internals are unavailable in action handlers",
                ),
              );
            const value = Reflect.get(object, property, object);
            if (typeof value === "function")
              return (...args: unknown[]) => {
                assertOwner(frame);
                if (property === "then") {
                  // Settle tracked SQL before resolving the caller's await continuation.
                  return sqlCall(frame, () => value.call(object)).then(
                    args[0] as never,
                    args[1] as never,
                  );
                }
                if (
                  executors.has(String(property)) ||
                  (property === "values" &&
                    (object === tx || typeof Reflect.get(object, "then", object) === "function"))
                )
                  return sqlCall(frame, () => value.apply(object, args));
                try {
                  const result: unknown = value.apply(object, args);
                  if (result instanceof Promise) {
                    const tracked = result.catch((cause: unknown) => {
                      throw fail(cause);
                    });
                    observe(tracked, frame.sql);
                    return observe(tracked, frame.pending);
                  }
                  return result !== null && typeof result === "object" ? guard(result) : result;
                } catch (cause) {
                  throw fail(cause);
                }
              };
            return value !== null && typeof value === "object" ? guard(value) : value;
          },
        });
        proxies.set(target, proxy);
        return proxy;
      }
      return guard(tx) as Tx;
    }
    function frameBindings(frame: Frame): ActionBindings {
      function resolve(path: string, type: "entityId" | "childId" | "clock") {
        assertOwner(frame);
        try {
          const scoped = actionBindingPath(
            frame.invocation.kind,
            ...frame.path,
            "allocation",
            path,
          );
          const value = bindings[type](scoped);
          frame.generated.set(
            scoped,
            Object.freeze(
              type === "clock"
                ? { type: "clock", value: value as number }
                : { type: type === "entityId" ? "entity-id" : "child-id", value: value as string },
            ),
          );
          return value;
        } catch (cause) {
          throw fail(cause);
        }
      }
      return Object.freeze({
        mode: bindings.mode,
        entityId: (path: string) => resolve(path, "entityId") as string,
        childId: (path: string) => resolve(path, "childId") as string,
        clock: (path: string) => resolve(path, "clock") as number,
        snapshot: () => Object.freeze(Object.fromEntries(frame.generated)),
      });
    }
    function dispatch(
      parent: Frame,
      path: readonly string[],
      kind: string,
      input: unknown,
      withId = false,
      expectedId?: string,
    ): Promise<unknown> {
      let promise: Promise<unknown>;
      try {
        assertOwner(parent);
        if (parent.sql.size)
          throw new ActionExecutionError("Cannot enter a child while parent SQL is outstanding");
        const prepared = freezeActionInput(prepareInput(input));
        if (!path.length) throw new ActionExecutionError("Child action requires a stable path");
        const stablePath = [...parent.path, actionBindingPath(kind, ...path)];
        const bindingPath = actionBindingPath(kind, ...parent.path, "child", ...path);
        const id = bindings.childId(bindingPath);
        parent.generated.set(bindingPath, Object.freeze({ type: "child-id", value: id }));
        if (expectedId !== undefined && id !== expectedId)
          throw new ActionExecutionError("Child action ID differs from recorded composition");
        if (ids.has(id)) throw new ActionExecutionError("Child action path or ID was used twice");
        ids.add(id);
        promise = invoke(
          { id, kind, contractVersion: invocation.contractVersion, input: prepared },
          parent,
          stablePath,
        );
        if (withId) promise = promise.then((result) => Object.freeze({ id, result }));
        const settled = promise.then(
          () => {
            parent.child = null;
          },
          () => {
            parent.child = null;
          },
        );
        parent.child = settled;
      } catch (cause) {
        promise = Promise.reject(fail(cause));
      }
      // An unawaited rejected child must still be observed and drained by the root.
      void promise.catch(() => {});
      return promise;
    }
    async function invoke(
      action: ActionInvocation,
      parent: Frame | null,
      path: readonly string[],
    ): Promise<unknown> {
      const frame: Frame = {
        invocation: action,
        parent,
        path,
        executionOrd: frames.length,
        generated: new Map(),
        pending: new Set(),
        sql: new Set(),
        open: true,
        child: null,
      };
      frames.push(frame);
      current = frame;
      const access: ActionFrameAccess = Object.freeze({
        id: action.id,
        parentId: parent?.invocation.id ?? null,
        kind: action.kind,
        contractVersion: invocation.contractVersion,
        child: (keys: readonly string[], kind: string, input: unknown) =>
          dispatch(frame, keys, kind, input),
        dispatch: (keys: readonly string[], kind: string, input: unknown, expectedId?: string) =>
          dispatch(frame, keys, kind, input, true, expectedId) as Promise<ActionChildResult>,
        check: () => assertOwner(frame),
        fail: (cause: unknown): never => {
          throw fail(cause);
        },
      });
      let result: unknown;
      let unbind: (() => void) | undefined;
      try {
        if (failed) throw firstFailure;
        await enter?.(
          tx,
          Object.freeze({ ...action, parentId: access.parentId, executionOrd: frame.executionOrd }),
        );
        if (failed) throw firstFailure;
        const handle = guardedHandle(frame);
        unbind = bindActionServiceFrame(handle, {
          check: () => assertOwner(frame),
          track: <T>(operation: Promise<T>): Promise<T> =>
            observe(
              operation.catch((cause: unknown) => {
                throw fail(cause);
              }),
              frame.pending,
            ),
        });
        const execution = {
          context: createContext(access, handle),
          bindings: frameBindings(frame),
        };
        result = await registry[bindings.mode === "record" ? "execute" : "replay"](
          action.kind as keyof Inputs & string,
          action.input,
          execution,
        );
      } catch (cause) {
        fail(cause);
      }
      frame.open = false;
      if (frame.child || frame.pending.size) {
        fail(new ActionExecutionError("Action handler returned with outstanding work"));
        if (frame.child) await frame.child;
        await Promise.all(frame.pending);
      }
      try {
        await leave?.(tx, action.id, access.parentId);
      } catch (cause) {
        fail(cause);
      }
      unbind?.();
      current = parent;
      if (failed) throw firstFailure;
      return result;
    }
    const result = await invoke(invocation, null, ["root", invocation.kind]);
    if (failed) throw firstFailure;
    const executions: readonly ActionExecutionRecord[] = Object.freeze(
      frames.map((frame) =>
        Object.freeze({
          ...frame.invocation,
          parentId: frame.parent?.invocation.id ?? null,
          executionOrd: frame.executionOrd,
          generated: Object.freeze(Object.fromEntries(frame.generated)),
        }),
      ),
    );
    const output: ActionGroupResult = Object.freeze({
      result,
      invocation,
      generated: bindings.snapshot(),
      executions,
    });
    await complete?.(tx, output);
    if (failed) throw firstFailure;
    await verifyActionConnection(executeConnection);
    if (failed) throw firstFailure;
    return output;
  });
}
