import { base } from "$app/paths";
import type { ProjectDataSnapshot } from "$lib/types.js";
import type { Activity } from "./activity.js";
import { readProjectSnapshot } from "./snapshot-reader.js";

/** How often the board asks the server whether anything has changed. */
export const SNAPSHOT_POLL_MS = 1_000;

export type SnapshotPollOptions = {
  fetcher: typeof fetch;
  /**
   * Read fresh on every tick rather than captured: one page component serves whichever
   * board is open, and a project navigation reuses it.
   */
  projectId: () => string;
  /**
   * Everything whose being in flight means a snapshot must wait — the user's own drags and
   * the mutations the action layer has outstanding. A poll stands down while any of them
   * is open, and an answer is dropped if any of them moved while it was on its way.
   */
  activities: readonly Activity[];
  /** Applied only once every guard above still holds. */
  apply: (snapshot: ProjectDataSnapshot) => void;
  /** Hidden tabs are not drawn, so polling one spends a request on nothing. */
  isHidden: () => boolean;
};

/**
 * Keeps a long-lived board in step with writes made by the CLI or another tab.
 *
 * Lifted out of `+page.svelte` because none of it is about rendering: it is a conditional
 * request, two guards against clobbering the user, and an ETag cache — all of which can be
 * driven directly by a test, where inside `onMount` they could only be reached by mounting
 * the whole page and waiting on timers.
 *
 * Returns the stop function, which the caller hands straight back from `onMount`.
 */
export function startSnapshotPoll({
  fetcher,
  projectId,
  activities,
  apply,
  isHidden,
}: SnapshotPollOptions): () => void {
  let refreshing = false;
  /**
   * The tag of the snapshot currently applied, and the project it describes. Sent back so
   * the server can answer "nothing new" instead of the whole board: most polls find no
   * change, and re-applying an identical snapshot rebuilds every reactive list on the page
   * once a second for nothing.
   *
   * Kept with its project because the same poll serves whichever board is open, and a tag
   * from the previous one would describe data this one never had.
   */
  let applied: { projectId: string; etag: string } | null = null;

  const refresh = async () => {
    if (refreshing || isHidden() || activities.some((activity) => !activity.idle)) return;
    refreshing = true;
    // Noted before the request so the answer can be checked against them afterwards; see
    // the note on `Activity.version` for the case the counts alone would miss.
    const versions = activities.map((activity) => activity.version);
    const currentProjectId = projectId();
    const known = applied?.projectId === currentProjectId ? applied.etag : null;
    try {
      const response = await fetcher(`${base}/${currentProjectId}/api/snapshot`, {
        // Revalidation is done by hand with the tag below, so the browser's own cache is
        // kept out of it — served from there, a 304 would arrive as a full 200 again.
        cache: "no-store",
        ...(known && { headers: { "if-none-match": known } }),
      });
      // 304: the board already matches the database, and there is nothing to apply.
      if (response.status === 304) return;
      if (!response.ok) return;
      // Read rather than trusted: `response.json()` resolves to `any`, and a body that is
      // not a snapshot would otherwise be applied as one. An unreadable body is dropped
      // exactly as a failed request is — the board keeps what it has, and no tag is
      // recorded, so the next poll asks for the whole thing again.
      const snapshot = readProjectSnapshot(await response.json());
      if (!snapshot) return;
      if (!activities.every((activity, index) => activity.unchangedSince(versions[index]))) return;
      apply(snapshot);
      // Recorded only once the data is actually on the board. A snapshot dropped by the
      // guard above was never applied, so claiming to hold it would leave the page waiting
      // on a change the server has already sent.
      //
      // No tag means no conditional request to make: the poll simply goes on asking for
      // the whole board, which is what it did before there was one to send.
      const etag = response.headers?.get("etag") ?? null;
      applied = etag ? { projectId: currentProjectId, etag } : null;
    } catch {
      // A later poll retries transient navigation or database failures.
    } finally {
      refreshing = false;
    }
  };

  const interval = window.setInterval(refresh, SNAPSHOT_POLL_MS);
  // A tab that comes back into view catches up at once rather than waiting out the tick it
  // spent hidden.
  const onVisibilityChange = () => {
    if (!isHidden()) void refresh();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", refresh);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", refresh);
  };
}
