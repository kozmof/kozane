/**
 * Protect unsaved edits when navigation, reloading, or tab closing would discard the
 * document. Panel closing has its own guard.
 */

/** The part of SvelteKit's `BeforeNavigate` this needs, so a test need not build one. */
export type LeaveIntent = {
  /** Use `"leave"` when the document unloads on tab close or reload. */
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
 * Cancel navigation if it would discard unsaved changes without confirmation. For leave
 * events, let the browser show its unload dialog. For in-app navigation, use the synchronous
 * `ask` callback.
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
