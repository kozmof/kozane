import type { DB, Tx } from "../database.js";
import { ValidationError } from "../errors.js";
import { prepareInput } from "../services/prepare-input.js";
import { createActionBindings, type ActionBindingMap, type ActionBindings } from "./bindings.js";
import {
  type ActionInputsV1,
  type CompositionChildV1,
  type SyncableActionKindV1,
} from "./contracts.js";
import {
  freezeActionInput,
  runActionGroup,
  type ActionFrameAccess,
  type ActionGroupResult,
  type ActionExecutionRecord,
  type ActionInvocation,
} from "./execution.js";
import { prepareActionInputV1 } from "./invocation.js";
import { createActionRegistryV1, type ActionHandlersV1 } from "./registry.js";
import { withActionService } from "./service-frame.js";

export type CompositionReadHandle = Pick<Tx, "select" | "selectDistinct" | "query">;
export interface CompositionReader<I, O> {
  prepare(input: unknown): I;
  read(db: CompositionReadHandle, input: I): Promise<O>;
}
export function defineCompositionReader<I, O>(
  reader: CompositionReader<I, O>,
): CompositionReader<I, O> {
  return Object.freeze({ ...reader });
}
type Readers = Record<
  string,
  {
    prepare(input: unknown): unknown;
    read(db: CompositionReadHandle, input: never): Promise<unknown>;
  }
>;
export interface CompositionAccess<R extends Readers> {
  read<K extends keyof R & string>(
    kind: K,
    input: Parameters<R[K]["read"]>[1],
  ): Promise<Awaited<ReturnType<R[K]["read"]>>>;
  dispatch<K extends SyncableActionKindV1>(
    path: readonly string[],
    kind: K,
    input: ActionInputsV1[K],
  ): Promise<unknown>;
}
export interface CompositionContext<C> {
  readonly value: C;
  readonly db: Tx;
  readonly actions: ActionFrameAccess;
  readonly recordComposition?: () => Promise<unknown>;
}

/** Install the registered list interpreter once for the whole contract version. */
export function createCompositionRegistryV1<C>(
  schemaVersions: readonly number[],
  handlers: Omit<ActionHandlersV1<CompositionContext<C>>, "system.compose">,
) {
  if (Object.hasOwn(handlers, "system.compose"))
    throw new TypeError("Composition owns the system.compose handler");
  return createActionRegistryV1<CompositionContext<C>>(schemaVersions, {
    ...handlers,
    "system.compose": {
      replay: async (input, execution) => {
        const { context } = execution;
        if (execution.bindings.mode === "record" && context.recordComposition)
          return context.recordComposition();
        for (const child of input.body.children) {
          await context.actions.dispatch(child.path, child.kind, child.input, child.id);
        }
      },
    },
  });
}
type Registry<C> = ReturnType<typeof createCompositionRegistryV1<C>>;
interface Persistence {
  readonly enter?: (db: Tx, execution: Omit<ActionExecutionRecord, "generated">) => Promise<void>;
  readonly leave?: (db: Tx, actionId: string, parentId: string | null) => Promise<void>;
  readonly complete?: (db: Tx, group: ActionGroupResult) => Promise<void>;
}
function readHandle(db: Tx, actions: ActionFrameAccess): CompositionReadHandle {
  const handle = Object.freeze({
    select: db.select.bind(db),
    selectDistinct: db.selectDistinct.bind(db),
    query: db.query,
  });
  const forbidden = new Set([
    "db",
    "insert",
    "update",
    "delete",
    "run",
    "all",
    "get",
    "values",
    "records",
    "transaction",
    "$client",
    "session",
  ]);
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (forbidden.has(String(property)))
        actions.fail(new ValidationError("Composition readers expose query builders only"));
      return Reflect.get(target, property, receiver);
    },
  });
}
function finalizedGroup(
  group: ActionGroupResult,
  children: readonly CompositionChildV1[],
): ActionGroupResult {
  const input = freezeActionInput(
    prepareActionInputV1("system.compose", { args: {}, body: { children } }),
  );
  const invocation = Object.freeze({ ...group.invocation, input });
  const executions = Object.freeze(
    group.executions.map((entry) =>
      entry.parentId === null ? Object.freeze({ ...entry, input }) : entry,
    ),
  );
  return Object.freeze({ ...group, invocation, executions });
}

/** Record the callback's direct calls once. The public facade never exposes a transaction handle. */
export async function composeActions<C, R extends Readers>(
  options: Persistence & {
    readonly db: DB;
    readonly id: string;
    readonly schemaVersion: number;
    readonly registry: Registry<C>;
    readonly bindings: ActionBindings;
    readonly value: C;
    readonly readers: R;
    readonly operation: (access: CompositionAccess<R>) => Promise<unknown>;
  },
): Promise<ActionGroupResult> {
  const { db, id, schemaVersion, registry, bindings, value, operation, enter, leave, complete } =
    options;
  if (bindings.mode !== "record") throw new TypeError("Composition callbacks are recording-only");
  if (typeof operation !== "function") throw new TypeError("Composition requires a callback");
  const readers = new Map(
    Object.entries(options.readers).map(([name, reader]) => {
      if (typeof reader?.prepare !== "function" || typeof reader.read !== "function")
        throw new TypeError(`Invalid composition reader: ${name}`);
      return [name, Object.freeze({ ...reader })] as const;
    }),
  );
  const children: CompositionChildV1[] = [];
  let output: ActionGroupResult | undefined;
  await runActionGroup({
    db,
    registry,
    schemaVersion,
    bindings,
    invocation: {
      id,
      kind: "system.compose",
      contractVersion: registry.contractVersion,
      input: { args: {}, body: { children: [] } },
    },
    createContext: (actions, handle): CompositionContext<C> => {
      if (actions.id !== id) return Object.freeze({ value, db: handle, actions });
      let dispatching = false;
      const methods: CompositionAccess<R> = Object.freeze({
        read: <K extends keyof R & string>(kind: K, input: Parameters<R[K]["read"]>[1]) =>
          withActionService<Awaited<ReturnType<R[K]["read"]>>>(
            handle,
            async (): Promise<Awaited<ReturnType<R[K]["read"]>>> => {
              actions.check();
              const reader = readers.get(kind);
              if (!reader) throw new ValidationError(`Unknown composition reader: ${kind}`);
              const prepared = reader.prepare(prepareInput(input));
              return (await reader.read(readHandle(handle, actions), prepared as never)) as Awaited<
                ReturnType<R[K]["read"]>
              >;
            },
          ),
        dispatch: <K extends SyncableActionKindV1>(
          path: readonly string[],
          kind: K,
          input: ActionInputsV1[K],
        ) => {
          const work = withActionService(handle, async () => {
            actions.check();
            if (dispatching)
              actions.fail(new ValidationError("Composition calls must be awaited sequentially"));
            const copied = prepareInput(input);
            const keys = prepareInput([...path]);
            dispatching = true;
            const child = await actions.dispatch(keys, kind, copied);
            children.push({ id: child.id, path: keys, kind, input: copied } as CompositionChildV1);
            return child.result;
          });
          void work.then(
            () => {
              dispatching = false;
            },
            () => {
              dispatching = false;
            },
          );
          return work;
        },
      });
      const forbidden = new Set([
        "db",
        "insert",
        "update",
        "delete",
        "run",
        "all",
        "get",
        "values",
        "select",
        "selectDistinct",
        "query",
        "records",
        "transaction",
        "$client",
      ]);
      const access = new Proxy(methods, {
        get(target, property, receiver) {
          if (forbidden.has(String(property)))
            actions.fail(
              new ValidationError("Composition callbacks use registered readers and dispatch"),
            );
          return Reflect.get(target, property, receiver);
        },
      });
      return Object.freeze({
        value,
        db: handle,
        actions,
        recordComposition: () => operation(access),
      });
    },
    enter,
    leave,
    complete: async (handle, group) => {
      const finalized = finalizedGroup(group, children);
      await complete?.(handle, finalized);
      output = finalized;
    },
  });
  if (!output) throw new Error("Composition did not complete");
  return output;
}

/** Interpret the frozen list with no callback or recording-time read helper execution. */
export function replayComposition<C>(
  options: Persistence & {
    readonly db: DB;
    readonly schemaVersion: number;
    readonly registry: Registry<C>;
    readonly invocation: ActionInvocation;
    readonly generated: ActionBindingMap;
    readonly value: C;
  },
): Promise<ActionGroupResult> {
  const { db, schemaVersion, registry, invocation, generated, value, enter, leave, complete } =
    options;
  if (invocation.kind !== "system.compose")
    throw new TypeError("Expected a system.compose invocation");
  return runActionGroup({
    db,
    schemaVersion,
    registry,
    invocation,
    bindings: createActionBindings({ mode: "replay", bindings: generated }),
    createContext: (actions, handle) => Object.freeze({ value, db: handle, actions }),
    enter,
    leave,
    complete,
  });
}
