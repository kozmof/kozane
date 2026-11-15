import { ValidationError } from "../errors.js";
import { actionBindingPath, type ActionBindings } from "./bindings.js";

export interface ImportedCardTimestamps {
  readonly id: string;
  readonly created_at?: number;
  readonly updated_at?: number;
}

/** Resolve import defaults separately from the original envelope. Never use this for exact restoration. */
export function resolveImportedCardTimestamps(
  card: ImportedCardTimestamps,
  bindings: ActionBindings,
): { created_at: number; updated_at: number } {
  if (!card.id || typeof card.id !== "string")
    throw new ValidationError("Imported card requires an ID");
  for (const column of ["created_at", "updated_at"] as const) {
    const value = card[column];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value)))
      throw new ValidationError(`Invalid imported card ${card.id}.${column}`);
  }
  const created_at =
    card.created_at === undefined || card.created_at === 0
      ? bindings.clock(actionBindingPath("system.import", "card", card.id, "created_at"))
      : card.created_at;
  if (created_at === 0)
    throw new ValidationError(`Imported card ${card.id} requires a nonzero timestamp`);
  const updated_at =
    card.updated_at === undefined || card.updated_at === 0 ? created_at : card.updated_at;
  return { created_at, updated_at };
}
