import type { ConfigSnapshot } from "../cli/lib/config-editor/handler.js";
import type { FieldSpec } from "../cli/lib/config-editor/fields.js";

/**
 * Pending edits keyed by field path. `null` removes the key from the file so its default
 * applies. A field with no entry is left as the file has it.
 */
export type Changes = Record<string, unknown>;

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isPresent(snapshot: ConfigSnapshot, field: FieldSpec): boolean {
  return hasOwn(snapshot.values, field.path);
}

export function hasChange(changes: Changes, field: FieldSpec): boolean {
  return hasOwn(changes, field.path);
}

/** The value the form shows: a pending change, then the file, then the default. */
export function currentValue(
  snapshot: ConfigSnapshot,
  changes: Changes,
  field: FieldSpec,
): unknown {
  if (hasChange(changes, field)) {
    const changed = changes[field.path];
    return changed === null ? field.defaultValue : changed;
  }
  if (isPresent(snapshot, field)) return snapshot.values[field.path];
  return field.defaultValue;
}

/** Whether the field falls back to its default once pending changes are saved. */
export function usesDefault(snapshot: ConfigSnapshot, changes: Changes, field: FieldSpec): boolean {
  if (hasChange(changes, field)) return changes[field.path] === null;
  return !isPresent(snapshot, field);
}

/**
 * Record a new value for `field`. Drop the entry when the value matches what the file already
 * says, so undoing an edit by hand leaves nothing to save.
 */
export function withChange(
  snapshot: ConfigSnapshot,
  changes: Changes,
  field: FieldSpec,
  value: unknown,
): Changes {
  const next = { ...changes };
  const present = isPresent(snapshot, field);
  const fileValue = present ? snapshot.values[field.path] : undefined;
  if (value === null) {
    if (present) next[field.path] = null;
    else delete next[field.path];
  } else if (!present && sameValue(value, field.defaultValue)) {
    delete next[field.path];
  } else if (present && sameValue(value, fileValue)) {
    delete next[field.path];
  } else {
    next[field.path] = value;
  }
  return next;
}

export function describeKey(key: string): string {
  if (key === "") return "(none)";
  if (key === " ") return "Space";
  return key;
}

/** A value as the page prints it, such as a default next to its setting. */
export function describeValue(field: FieldSpec, value: unknown): string {
  if (value === undefined) return "";
  if (field.kind === "boolean") return value ? "on" : "off";
  if (field.kind === "shortcut") return describeKey(String(value));
  if (field.kind === "list") return Array.isArray(value) ? value.join(", ") : String(value);
  return String(value);
}

/**
 * The change a number input stands for. A blank input, which Svelte binds as `null`, means
 * "use the default".
 */
export function numberChange(value: number | null | undefined): unknown {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return value;
}

/** One entry per non-blank line. */
export function parseListInput(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Text a field's control starts with. */
export function controlText(field: FieldSpec, value: unknown): string {
  if (field.kind === "list") return Array.isArray(value) ? value.join("\n") : "";
  if (field.kind === "shortcut") return typeof value === "string" ? describeKey(value) : "";
  if (field.kind === "number") return typeof value === "number" ? String(value) : "";
  return typeof value === "string" ? value : "";
}

export function matchesFilter(field: FieldSpec, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [field.label, field.path, field.help].some((text) => text.toLowerCase().includes(needle));
}

/** Keys that only modify another key, so pressing one alone binds nothing. */
export const MODIFIER_KEYS: readonly string[] = ["Shift", "Control", "Alt", "Meta", "CapsLock"];
