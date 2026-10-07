/**
 * Resolve board shortcuts through an ordered binding table. Run only the first matching
 * enabled action when keys overlap.
 *
 * Keep keyboard ownership guards on the page. Palettes, editors, repeated keys, and
 * text-field focus decide whether the board receives a key before this table decides its
 * action.
 */

/**
 * The part of a `KeyboardEvent` a binding is matched on and may act through.
 *
 * Structural rather than `KeyboardEvent`, so the dispatcher and every binding over it can
 * be driven from a test with an object literal. The page passes the real event, which
 * satisfies this already.
 */
export type BoardKeyEvent = {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
};

export type KeyBinding = {
  /** Internal binding name used by tests and inspection helpers to identify actions. */
  name: string;
  /**
   * Accepted `event.key` values. A single action can handle several keys, such as the four
   * warp arrows.
   */
  keys: readonly string[];
  /**
   * Require Shift when true, forbid it when false, or ignore it when omitted. Arrow bindings
   * need this distinction because their `event.key` does not change with Shift. Letter keys
   * already reflect capitalization.
   */
  shift?: boolean;
  /**
   * Whether the binding is currently enabled. Skip disabled bindings and continue looking for
   * another match.
   */
  when?: () => boolean;
  /**
   * Whether to cancel browser handling before running the action. Actions that cancel only on
   * success, such as warp navigation, handle `preventDefault` themselves.
   */
  preventDefault?: boolean;
  run: (event: BoardKeyEvent) => void;
};

/** Run the first enabled binding matching the keystroke and return whether one matched. */
export function runKeyBindings(event: BoardKeyEvent, bindings: readonly KeyBinding[]): boolean {
  for (const binding of bindings) {
    if (!binding.keys.includes(event.key)) continue;
    if (binding.shift !== undefined && binding.shift !== event.shiftKey) continue;
    if (binding.when && !binding.when()) continue;
    if (binding.preventDefault) event.preventDefault();
    binding.run(event);
    return true;
  }
  return false;
}

/**
 * Whether a keystroke aimed at this element is someone typing rather than someone reaching
 * for a shortcut.
 *
 * `isContentEditable` is checked as well as the two tag names because the editor panel and
 * the composer are not the only places text goes, and an element that takes text without
 * being an `<input>` would otherwise have every letter of it read as a command.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // Return an explicit boolean because jsdom can omit `isContentEditable` on ordinary
  // elements.
  return Boolean(
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable,
  );
}

/**
 * Detect modifiers reserved for browser or host shortcuts. Allow Shift because board
 * shortcuts can use capital letters and Shift-arrow chords.
 */
export function hasCommandModifier(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

/**
 * Group bindings by key and Shift requirement in dispatch order. Do not evaluate live `when`
 * conditions, so this reports potential collisions rather than current reachability.
 */
export function bindingsByKey(bindings: readonly KeyBinding[]): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const binding of bindings) {
    for (const key of binding.keys) {
      const slot =
        binding.shift === undefined ? key : `${binding.shift ? "Shift+" : "!Shift+"}${key}`;
      claims.set(slot, [...(claims.get(slot) ?? []), binding.name]);
    }
  }
  return claims;
}
