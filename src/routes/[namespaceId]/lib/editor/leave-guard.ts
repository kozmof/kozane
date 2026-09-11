/**
 * What to do about an unsaved file when the page itself is going away.
 *
 * Closing the panel already asks — see `requestClose` in `FileEditor.svelte` — but that
 * only covers the ways out that go through the panel. A link to another namespace, the
 * back button, and the window's close box all leave the same edit behind without ever
 * touching it, and the document goes with the page, so there is no undo left to reach for.
 */

/** The part of SvelteKit's `BeforeNavigate` this needs, so a test need not build one. */
export type LeaveIntent = {
  /** `"leave"` when the document itself is unloading: the tab closing, or a reload. */
  type: string;
  cancel: () => void;
};

/**
 * Asked before an in-app navigation. The wording for a tab being closed is the browser's
 * own and cannot be set from here, so the two questions do not read alike however this is
 * phrased.
 */
export const UNSAVED_LEAVE_PROMPT = "This file has unsaved changes. Leave and discard them?";

/**
 * Cancels `nav` when leaving would throw an unsaved edit away and nobody said to. Returns
 * whether it cancelled.
 *
 * A `leave` is the tab closing or reloading, which no script can hold open: cancelling is
 * how SvelteKit is told to mark the `beforeunload` event, and the browser takes it from
 * there with a dialog of its own wording. Every other kind is a navigation within the app,
 * which is ours to stop, so it is `ask` that decides — and `ask` has to answer now, because
 * a navigation cannot be left hanging while a panel waits for a click.
 */
export function guardUnsavedLeave(nav: LeaveIntent, dirty: boolean, ask: () => boolean): boolean {
  if (!dirty) return false;
  if (nav.type === "leave") {
    nav.cancel();
    return true;
  }
  if (ask()) return false;
  nav.cancel();
  return true;
}
