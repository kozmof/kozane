import type { AnyDB, Tx } from "../database.js";
import { ActionBindingError, actionBindingPath, type ActionBindings } from "./bindings.js";

interface AllocationFrame {
  readonly bindings: ActionBindings;
  check(): void;
  fail(cause: unknown): never;
}
const frames = new WeakMap<AnyDB, AllocationFrame>();

/** Keep closed handles bound so they cannot fall back to fresh ORM or clock allocations. */
export function bindActionAllocations(handle: Tx, frame: AllocationFrame): void {
  if (frames.has(handle)) throw new Error("Action allocation handle already bound");
  frames.set(handle, frame);
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
  return resolve(db, (bindings) => {
    const path = actionBindingPath("clock", "card", ...keys);
    const seconds = bindings.clock(path);
    const date = new Date(seconds * 1000);
    if (seconds === 0 || !Number.isFinite(date.getTime()))
      throw new ActionBindingError(
        path,
        "Card timestamps must be nonzero and representable as dates",
      );
    return date;
  });
}
