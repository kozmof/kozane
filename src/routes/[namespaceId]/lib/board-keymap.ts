/**
 * The board's keyboard shortcuts as a table, and the one rule that resolves them.
 *
 * `+page.svelte` dispatched these as ninety lines of sequential `if`, each branch comparing
 * `event.key` against a field of `data.uiConfig` and `return`ing. That worked, and the
 * reason it worked was written down beside it — "one key, one action: each branch returns,
 * so a config that binds two shortcuts to the same key does one thing rather than both".
 *
 * The trouble is where that rule lived. It was a property of nine `return` statements, so
 * it held only for as long as every future branch remembered to have one, and the
 * conditions a shortcut depends on were spread across three kinds of place: in the branch's
 * own `if` for some, in an earlier bare `return` gate for others (`if (readonly) return`,
 * `if (selection.size > 0) return`), and in prose for the rest. Reading off which keys do
 * what under which conditions meant executing the function in your head.
 *
 * `validateUiOverrides` in `$lib/ui-config` already warns when two shortcut fields name the
 * same key, and words the consequence exactly: "the page fires whichever action it reaches
 * first and the other becomes unreachable". {@link runKeyBindings} is that sentence, once,
 * as code — so the diagnostic describes a rule the dispatcher states rather than one the
 * page happens to have.
 *
 * ## What a binding may not do
 *
 * Decide the *order* the gates run in. The page's own guards — a palette or the editor
 * owning the keyboard, a held key repeating, focus sitting in a text field — are about who
 * the keystroke belongs to rather than what it means, and they stay where they are, above
 * this. A binding only says: these keys, under this condition, do this.
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
  /**
   * What this binding does, for the tests and the inspection helper below. Not shown to
   * anyone: a name here is how a table of nine anonymous closures becomes something a
   * failure can point at.
   */
  name: string;
  /**
   * The keys that reach it, as `event.key` spells them. A list because the warp bindings
   * are one action over four arrows — the direction is how the hand already reaches for
   * warping, not a separate shortcut.
   */
  keys: readonly string[];
  /**
   * Whether Shift must be held (`true`), must not be (`false`), or is not consulted
   * (omitted).
   *
   * Only the arrow bindings need it, and they need it because `event.key` carries Shift for
   * a letter and not for an arrow: a shortcut configured as `A` arrives as `"A"` and
   * matches by key alone, while Shift+ArrowUp arrives as `"ArrowUp"` and is a different
   * action from ArrowUp. Omitted elsewhere, which is what the letter shortcuts have always
   * done.
   */
  shift?: boolean;
  /**
   * When this binding is live. A binding whose condition does not hold is *passed over*
   * rather than ending the dispatch — which is the behaviour of the `if (!readonly && …)`
   * and `if (pendingRect && …)` branches this replaces, and it matters: a workspace where
   * the focus-composer key is also the toggle-footers key still toggles footers in a
   * read-only export, where focusing a composer there is not is nothing to do.
   */
  when?: () => boolean;
  /**
   * Whether the browser's own handling of the key is cancelled before `run`.
   *
   * Data rather than a line inside `run`, because for most of these it is unconditional and
   * saying so beside the keys is where a reader looks for it. The exception is warp
   * navigation, which cancels only when it finds somewhere to go — arrowing past the last
   * warp has to leave the key alone — so that one omits this and calls `preventDefault`
   * itself.
   */
  preventDefault?: boolean;
  run: (event: BoardKeyEvent) => void;
};

/**
 * Runs the first binding that claims this keystroke, and reports whether one did.
 *
 * First match wins, and a binding whose `when` is false is not a match — see the note on
 * `when`. The return value is for the tests and for a caller that wants to fall through to
 * something else; the page ignores it, because nothing sits below the board.
 */
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
  // `Boolean(...)` rather than returning the chain: `isContentEditable` is typed `boolean`
  // on `HTMLElement` and is one in a browser, but it is absent under jsdom, so the `||`
  // chain hands back `undefined` for an ordinary element and the declared return type is a
  // claim the host has to honour for it to hold. Inside the `if` this replaces it was
  // truthiness and could not be observed; as a returned value it can.
  return Boolean(
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable,
  );
}

/**
 * Whether a keystroke carries a modifier that takes it out of the board's hands.
 *
 * Every shortcut here is a single key, and `event.key` carries no modifier but Shift — so
 * without this, Ctrl/Cmd+A reads as whatever is bound to `"a"`, and the browser's own
 * Ctrl/Cmd shortcuts each collide with the letter that matches them. Shift is the
 * exception, and deliberately: it is half of the warp palette's chord, and a shortcut may
 * be configured as a capital letter (`toggleWarpsShortcut` is `A` by default).
 */
export function hasCommandModifier(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

/**
 * The bindings claiming each key, in the order {@link runKeyBindings} would reach them.
 *
 * For the tests, and for anything that wants to ask of a *table* the question
 * `validateUiOverrides` asks of a *config*: does more than one action answer to this key,
 * and which one wins. Keyed by the key and the Shift requirement together, since
 * Shift+ArrowUp and ArrowUp are not competing for the same keystroke.
 *
 * `when` is not consulted — it is evaluated per keystroke against live page state, so
 * whether a collision is reachable is not a question this can answer. Which of two
 * colliding bindings the dispatcher prefers is, and that is the part worth asserting.
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
