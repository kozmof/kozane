import { isActionIdentity } from "./identity.js";
import { INPUT_MAX_NODES, INPUT_MAX_STRING_UNITS } from "../services/prepare-input.js";

/** Durable allocations are JSON scalars, never driver or ORM values. */
export type ActionBinding =
  | { readonly type: "entity-id" | "child-id"; readonly value: string }
  | { readonly type: "clock"; readonly value: number };
export type ActionBindingMap = Readonly<Record<string, ActionBinding>>;

export class ActionBindingError extends Error {
  override readonly name = "ActionBindingError";
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${message}: ${path}`);
  }
}

/** JSON tuples avoid collisions between keys containing separators. Use entity keys, not query indexes. */
export function actionBindingPath(kind: string, ...keys: readonly string[]): string {
  if (!kind || keys.length === 0 || keys.some((key) => typeof key !== "string" || !key))
    throw new ActionBindingError(kind, "Binding paths require a kind and stable keys");
  return JSON.stringify([kind, ...keys]);
}

function validBinding(binding: ActionBinding): boolean {
  return binding.type === "clock"
    ? Number.isSafeInteger(binding.value)
    : (binding.type === "entity-id" || binding.type === "child-id") &&
        isActionIdentity(binding.value);
}

/** Read plain data objects without executing getters or serialization hooks. */
function recordedFields(input: unknown, path: string): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new ActionBindingError(path, "Invalid recorded binding object");
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== "string" || !field.enumerable || !("value" in field))
      throw new ActionBindingError(path, "Recorded bindings require plain data fields");
    fields[key] = field.value;
  }
  return fields;
}

/** Own one provider per root execution. Replays never call allocation sources or extend bindings. */
export function createActionBindings(
  options:
    | { readonly mode: "record"; readonly allocateId: () => string; readonly now: () => number }
    | { readonly mode: "replay"; readonly bindings: ActionBindingMap },
) {
  // Own the mode and allocation sources for the provider's entire lifetime.
  const source =
    options.mode === "record"
      ? Object.freeze({ mode: options.mode, allocateId: options.allocateId, now: options.now })
      : Object.freeze({ mode: options.mode, bindings: options.bindings });
  const bindings = new Map<string, ActionBinding>();
  let stringUnits = 0;
  function checkCapacity(path: string, type: ActionBinding["type"], valueUnits = 0) {
    // The JSON map owns one node and each binding owns an object and two scalar nodes.
    const addedUnits = path.length + "typevalue".length + type.length + valueUnits;
    if (
      1 + 3 * (bindings.size + 1) > INPUT_MAX_NODES ||
      stringUnits + addedUnits > INPUT_MAX_STRING_UNITS
    )
      throw new ActionBindingError(path, "Action bindings exceed input limits");
    return addedUnits;
  }
  function retain(path: string, binding: ActionBinding) {
    const addedUnits = checkCapacity(
      path,
      binding.type,
      typeof binding.value === "string" ? binding.value.length : 0,
    );
    bindings.set(path, Object.freeze(binding));
    stringUnits += addedUnits;
  }
  if (source.mode === "replay") {
    for (const [path, input] of Object.entries(recordedFields(source.bindings, ""))) {
      if (!path) throw new ActionBindingError(path, "Invalid recorded binding path");
      const fields = recordedFields(input, path);
      const binding = { type: fields.type, value: fields.value } as ActionBinding;
      if (Object.keys(fields).length !== 2 || !validBinding(binding))
        throw new ActionBindingError(path, "Invalid recorded binding");
      retain(path, binding);
    }
  }
  function resolve(path: string, type: ActionBinding["type"]): string | number {
    if (typeof path !== "string" || !path)
      throw new ActionBindingError(
        typeof path === "string" ? path : "",
        "Binding paths require nonempty strings",
      );
    const existing = bindings.get(path);
    if (existing) {
      if (existing.type !== type) throw new ActionBindingError(path, "Binding type changed");
      return existing.value;
    }
    if (source.mode === "replay") throw new ActionBindingError(path, "Unbound replay allocation");
    checkCapacity(path, type);
    const binding = (
      type === "clock" ? { type, value: source.now() } : { type, value: source.allocateId() }
    ) as ActionBinding;
    if (!validBinding(binding)) throw new ActionBindingError(path, "Invalid allocation");
    retain(path, binding);
    return binding.value;
  }
  return Object.freeze({
    mode: source.mode,
    entityId: (path: string): string => resolve(path, "entity-id") as string,
    childId: (path: string): string => resolve(path, "child-id") as string,
    /** Epoch seconds, matching SQLite timestamp columns. Inject a source that returns seconds. */
    clock: (path: string): number => resolve(path, "clock") as number,
    snapshot: (): ActionBindingMap => Object.freeze(Object.fromEntries(bindings)),
  });
}
export type ActionBindings = ReturnType<typeof createActionBindings>;
