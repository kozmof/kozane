import { ValidationError } from "./errors.js";

/** Maximum nested object or array containers, including the root. */
export const INPUT_MAX_DEPTH = 64;

export const INPUT_VALIDATION_MESSAGE = "Input must contain only JSON-compatible values";

/** Copy input before dispatch or validation without invoking accessors or serialization hooks. */
export function prepareInput<T>(input: T): T {
  const active = new Set<object>();
  const invalid = (): never => {
    throw new ValidationError(INPUT_VALIDATION_MESSAGE);
  };
  function copy(value: unknown, depth = 0): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
    if (typeof value !== "object") return invalid();
    if (depth >= INPUT_MAX_DEPTH || active.has(value)) return invalid();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return invalid();
    active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol" || !("value" in descriptors[key])) return invalid();
      }
      if (array) {
        const output: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || descriptor.value === undefined) return invalid();
          output.push(copy(descriptor.value, depth + 1));
        }
        // Extra array properties are not part of the JSON array value, but cannot hide hooks.
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key) && descriptor.value !== undefined)
            copy(descriptor.value, depth + 1);
        }
        return output;
      }
      const output: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor.value === undefined) continue;
        const copied = copy(descriptor.value, depth + 1);
        if (descriptor.enumerable)
          Object.defineProperty(output, key, {
            value: copied,
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      return output;
    } finally {
      active.delete(value);
    }
  }
  return copy(input) as T;
}
