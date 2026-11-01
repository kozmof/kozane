/** Argument parsers for option values. Stateless, so repeated command-tree builds reuse them. */
import { InvalidArgumentError } from "commander";
import { CARD_SORT_KEYS, isCardSortKey, type CardSortKey } from "../lib/card-sort.js";

export function integer(value: string): number {
  // `Number("")` and `Number(" ")` are 0, so refuse blank input before converting it.
  const parsed = value.trim() === "" ? NaN : Number(value);
  if (!Number.isInteger(parsed)) throw new InvalidArgumentError("Must be an integer.");
  return parsed;
}

export function nonNegativeInteger(value: string): number {
  const parsed = integer(value);
  if (parsed < 0) throw new InvalidArgumentError("Must be 0 or greater.");
  return parsed;
}

export function cardPosition(value: string): number | string {
  if (/^current[+-]\d+$/.test(value)) return value;
  try {
    return integer(value);
  } catch {
    throw new InvalidArgumentError(
      'Must be an integer or relative position such as "current+100".',
    );
  }
}

export function cardSortKey(value: string): CardSortKey {
  if (!isCardSortKey(value))
    throw new InvalidArgumentError(`Must be one of: ${CARD_SORT_KEYS.join(", ")}.`);
  return value;
}
