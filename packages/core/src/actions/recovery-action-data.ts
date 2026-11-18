/** Private strict JSON and field parsing shared by recovery preparation formats. */
import type { ActionInvocation } from "./execution.js";
import type { ActionBindingMap, ActionBinding } from "./bindings.js";
import {
  INPUT_MAX_DEPTH,
  INPUT_MAX_NODES,
  INPUT_MAX_STRING_UNITS,
} from "../services/prepare-input.js";
import { SharedRecoveryError } from "./shared-recovery.js";

export function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new SharedRecoveryError("Invalid recovery execution object");
  return Object.fromEntries(
    names.map((name) => {
      const field = Object.getOwnPropertyDescriptor(input, name);
      if (!field || !("value" in field) || !field.enumerable)
        throw new SharedRecoveryError("Recovery execution requires plain data fields");
      return [name, field.value];
    }),
  );
}
export function array(input: unknown): unknown[] {
  if (!Array.isArray(input) || Reflect.ownKeys(input).length !== input.length + 1)
    throw new SharedRecoveryError("Invalid recovery execution array");
  return Array.from({ length: input.length }, (_, n) => {
    const field = Object.getOwnPropertyDescriptor(input, String(n));
    if (!field || !("value" in field) || !field.enumerable)
      throw new SharedRecoveryError("Recovery execution requires plain array entries");
    return field.value;
  });
}
export function id(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 1000 ||
    input.includes("\0") ||
    !input.isWellFormed()
  )
    throw new SharedRecoveryError("Invalid recovery execution identity");
  return input;
}
export function integer(input: unknown, minimum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum)
    throw new SharedRecoveryError("Invalid recovery execution count or ordinal");
  return input as number;
}

/** Strict canonical JSON preserves string values and owns every input without invoking hooks. */
export function json(input: unknown): unknown {
  let nodes = 0,
    units = 0;
  const active = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > INPUT_MAX_NODES)
      throw new SharedRecoveryError("Recovery execution JSON exceeds input limits");
    if (typeof value === "string") units += value.length;
    if (units > INPUT_MAX_STRING_UNITS)
      throw new SharedRecoveryError("Recovery execution JSON exceeds input limits");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
    if (!value || typeof value !== "object" || depth >= INPUT_MAX_DEPTH || active.has(value))
      throw new SharedRecoveryError("Recovery execution requires finite plain JSON");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > INPUT_MAX_NODES - nodes)
          throw new SharedRecoveryError("Recovery execution JSON exceeds input limits");
        return Object.freeze(array(value).map((child) => copy(child, depth + 1)));
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new SharedRecoveryError("Recovery execution requires finite plain JSON");
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string") || keys.length > INPUT_MAX_NODES - nodes)
        throw new SharedRecoveryError("Recovery execution requires finite plain JSON");
      return Object.freeze(
        Object.fromEntries(
          (keys as string[]).sort().map((key) => {
            units += key.length;
            const field = Object.getOwnPropertyDescriptor(value, key)!;
            if (!("value" in field) || !field.enumerable)
              throw new SharedRecoveryError("Recovery execution requires plain JSON fields");
            return [key, copy(field.value, depth + 1)];
          }),
        ),
      );
    } finally {
      active.delete(value);
    }
  }
  return copy(input, 0);
}
export function bindings(input: unknown): ActionBindingMap {
  const value = json(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SharedRecoveryError("Invalid recovery execution bindings");
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([path, input]) => {
        if (!path) throw new SharedRecoveryError("Invalid recovery execution binding path");
        const binding = fields(input, ["type", "value"]);
        if (binding.type !== "entity-id" && binding.type !== "child-id" && binding.type !== "clock")
          throw new SharedRecoveryError("Invalid recovery execution binding type");
        if (binding.type === "clock") {
          if (!Number.isSafeInteger(binding.value))
            throw new SharedRecoveryError("Invalid recovery execution clock binding");
        } else id(binding.value);
        return [path, Object.freeze({ type: binding.type, value: binding.value }) as ActionBinding];
      }),
    ),
  );
}
export function invocation(input: unknown): ActionInvocation {
  const value = fields(input, ["id", "kind", "contractVersion", "input"]);
  return Object.freeze({
    id: id(value.id),
    kind: id(value.kind),
    contractVersion: integer(value.contractVersion, 1),
    input: json(value.input),
  });
}
