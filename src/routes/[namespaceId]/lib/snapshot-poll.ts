import { base } from "$app/paths";
import type { NamespaceDataSnapshot } from "$lib/types.js";
import type { InFlight } from "./in-flight.js";
import { readNamespaceSnapshot } from "./snapshot-reader.js";

/** How often the board asks the server whether anything has changed. */
export const SNAPSHOT_POLL_MS = 1_000;

export type SnapshotPollOptions = {
  fetcher: typeof fetch;
  /** Read current values on every tick because namespace navigation reuses the page component. */
  namespaceId: () => string;
  /**
   * Activity trackers for drags and mutations. Wait while any is active and discard responses
   * spanning a tracker change.
   */
  activities: readonly InFlight[];
  /** Applied only once every guard above still holds. */
  apply: (snapshot: NamespaceDataSnapshot) => void;
  /** Hidden tabs are not drawn, so polling one spends a request on nothing. */
  isHidden: () => boolean;
};

/**
 * Poll for external workspace writes using ETags and activity guards. Return a stop function
 * for the component's lifecycle cleanup.
 */
export function startSnapshotPoll({
  fetcher,
  namespaceId,
  activities,
  apply,
  isHidden,
}: SnapshotPollOptions): () => void {
  let refreshing = false;
  /**
   * Store the applied snapshot's tag with its namespace for conditional requests. This avoids
   * replacing unchanged reactive lists and prevents reusing a tag from a different board.
   */
  let applied: { namespaceId: string; etag: string } | null = null;

  const refresh = async () => {
    if (refreshing || isHidden() || activities.some((activity) => !activity.idle)) return;
    refreshing = true;
    // Capture activity versions before the request to detect edits that start and finish
    // while it is in flight.
    const versions = activities.map((activity) => activity.version);
    const currentNamespaceId = namespaceId();
    const known = applied?.namespaceId === currentNamespaceId ? applied.etag : null;
    try {
      const response = await fetcher(`${base}/${currentNamespaceId}/api/snapshot`, {
        // Disable the browser cache because this poll handles ETag revalidation explicitly.
        cache: "no-store",
        ...(known && { headers: { "if-none-match": known } }),
      });
      // 304: the board already matches the database, and there is nothing to apply.
      if (response.status === 304) return;
      if (!response.ok) return;
      // Validate the response before applying it. Preserve the current board and leave the
      // ETag unset when parsing fails so the next poll requests a full snapshot.
      const snapshot = readNamespaceSnapshot(await response.json());
      if (!snapshot) return;
      // Discard responses for a namespace left during the request. The next poll targets the
      // current board.
      if (namespaceId() !== currentNamespaceId) return;
      if (!activities.every((activity, index) => activity.unchangedSince(versions[index]))) return;
      apply(snapshot);
      // Record a tag only after applying its snapshot. Without a tag, keep requesting full
      // snapshots.
      const etag = response.headers?.get("etag") ?? null;
      applied = etag ? { namespaceId: currentNamespaceId, etag } : null;
    } catch {
      // A later poll retries transient navigation or database failures.
    } finally {
      refreshing = false;
    }
  };

  // Use the same void-returning wrapper for each fire-and-forget refresh trigger.
  const tick = () => void refresh();
  const interval = window.setInterval(tick, SNAPSHOT_POLL_MS);
  // A tab that comes back into view catches up at once rather than waiting out the tick it
  // spent hidden.
  const onVisibilityChange = () => {
    if (!isHidden()) void refresh();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", tick);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", tick);
  };
}
