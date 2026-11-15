import type { AnyDB, Tx } from "../database.js";
import { ActionBindingError, actionBindingPath, type ActionBindings } from "./bindings.js";

interface AllocationFrame {
  readonly bindings: ActionBindings;
  check(): void;
  fail(cause: unknown): never;
}
const frames = new WeakMap<AnyDB, AllocationFrame>();
const providers = new WeakMap<ActionBindings, AllocationFrame>();

export class ActionScopeRequiredError extends Error {
  override readonly name = "ActionScopeRequiredError";
  readonly code = "action-scope-required";
  constructor() {
    super("Service actions require their owning execution scope and binding provider");
  }
}

/** Refuse direct registry dispatch with an ordinary transaction or another frame's provider. */
export function requireActionAllocations(db: Tx, bindings: ActionBindings): void {
  const frame = frames.get(db);
  if (!frame) {
    const owner = providers.get(bindings);
    if (owner) {
      owner.check();
      owner.fail(new ActionScopeRequiredError());
    }
    throw new ActionScopeRequiredError();
  }
  try {
    frame.check();
    if (frame.bindings !== bindings) throw new ActionScopeRequiredError();
  } catch (cause) {
    frame.fail(cause);
  }
}

/** Keep closed handles bound so they cannot fall back to fresh ORM or clock allocations. */
export function bindActionAllocations(handle: Tx, frame: AllocationFrame): void {
  if (frames.has(handle) || providers.has(frame.bindings))
    throw new Error("Action allocation handle or provider already bound");
  frames.set(handle, frame);
  providers.set(frame.bindings, frame);
}

function resolve<T>(db: AnyDB, operation: (bindings: ActionBindings) => T): T | undefined {
  const frame = frames.get(db);
  if (!frame) return undefined;
  try {
    frame.check();
    return operation(frame.bindings);
  } catch (cause) {
    return frame.fail(cause);
  }
}

/** Undefined preserves the existing ORM default on handles outside an action scope. */
export function boundEntityId(
  db: AnyDB,
  table: string,
  ...keys: readonly string[]
): string | undefined {
  return resolve(db, (bindings) => bindings.entityId(actionBindingPath("entity", table, ...keys)));
}

/** Card timestamp zero is a legacy SQL sentinel and would invoke an unbound trigger clock. */
export function boundCardTimestamp(db: AnyDB, ...keys: readonly string[]): Date | undefined {
  return boundTimestamp(db, "card", "Card", true, keys);
}

/** Taskspaces have no SQL clock sentinel, so a recorded Unix epoch remains valid. */
export function boundTaskspaceTimestamp(db: AnyDB, ...keys: readonly string[]): Date | undefined {
  return boundTimestamp(db, "taskspace", "Taskspace", false, keys);
}

function boundTimestamp(
  db: AnyDB,
  table: string,
  label: string,
  nonzero: boolean,
  keys: readonly string[],
): Date | undefined {
  return resolve(db, (bindings) => {
    const path = actionBindingPath("clock", table, ...keys);
    const seconds = bindings.clock(path);
    const date = new Date(seconds * 1000);
    if ((nonzero && seconds === 0) || !Number.isFinite(date.getTime()))
      throw new ActionBindingError(
        path,
        `${label} timestamps must be ${nonzero ? "nonzero and " : ""}representable as dates`,
      );
    return date;
  });
}
