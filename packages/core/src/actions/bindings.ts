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
        typeof binding.value === "string" &&
        binding.value.length > 0;
}

/** Own one provider per root execution. Replays never call allocation sources or extend bindings. */
export function createActionBindings(
  options:
    | { readonly mode: "record"; readonly allocateId: () => string; readonly now: () => number }
    | { readonly mode: "replay"; readonly bindings: ActionBindingMap },
) {
  const bindings = new Map<string, ActionBinding>();
  if (options.mode === "replay") {
    for (const [path, binding] of Object.entries(options.bindings)) {
      if (!path || !binding || !validBinding(binding))
        throw new ActionBindingError(path, "Invalid recorded binding");
      bindings.set(
        path,
        Object.freeze({ type: binding.type, value: binding.value }) as ActionBinding,
      );
    }
  }
  function resolve(path: string, type: ActionBinding["type"]): string | number {
    if (!path) throw new ActionBindingError(path, "Empty binding path");
    const existing = bindings.get(path);
    if (existing) {
      if (existing.type !== type) throw new ActionBindingError(path, "Binding type changed");
      return existing.value;
    }
    if (options.mode === "replay") throw new ActionBindingError(path, "Unbound replay allocation");
    const binding = (
      type === "clock" ? { type, value: options.now() } : { type, value: options.allocateId() }
    ) as ActionBinding;
    if (!validBinding(binding)) throw new ActionBindingError(path, "Invalid allocation");
    bindings.set(path, Object.freeze(binding));
    return binding.value;
  }
  return Object.freeze({
    mode: options.mode,
    entityId: (path: string): string => resolve(path, "entity-id") as string,
    childId: (path: string): string => resolve(path, "child-id") as string,
    /** Epoch seconds, matching SQLite timestamp columns. Inject a source that returns seconds. */
    clock: (path: string): number => resolve(path, "clock") as number,
    snapshot: (): ActionBindingMap => Object.freeze(Object.fromEntries(bindings)),
  });
}
export type ActionBindings = ReturnType<typeof createActionBindings>;
