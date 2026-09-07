import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { openedDbUrl } from "$db/client";
import {
  matchesEtag,
  rememberSnapshotEtag,
  snapshotEtag,
  unchangedSnapshotEtag,
} from "$lib/server/snapshot-etag";
import { loadProjectSnapshot } from "../../lib/project-snapshot.js";

export const GET: RequestHandler = async ({ locals, params, request }) => {
  const { projectId } = params;
  const ifNoneMatch = request.headers.get("if-none-match");
  const dbUrl = openedDbUrl();

  // The cheap answer first. The board is polled once a second for as long as it is open,
  // and almost every one of those polls finds nothing new — but finding that out used to
  // mean running the whole read and serializing it, because the tag is a hash of the bytes.
  // If the database file has not moved since the tag the client is offering was computed,
  // that tag is still correct and none of that work has to happen. See
  // `lib/server/snapshot-etag.ts` for why the file's identity settles it, and for the ways
  // this declines to answer.
  const unchanged = unchangedSnapshotEtag(dbUrl, projectId);
  if (unchanged && matchesEtag(ifNoneMatch, unchanged)) {
    return new Response(null, {
      status: 304,
      headers: { etag: unchanged, "cache-control": "no-store" },
    });
  }

  // The same read the page load makes, so the board the poll replaces cannot be assembled
  // differently from the board it replaces. `path` is sent as stored — unlike the static
  // export, which nulls it; see the note on `includeTaskspacePaths`.
  const loaded = await loadProjectSnapshot({
    db: locals.db,
    projectId,
    includeTaskspacePaths: true,
    includeScopes: true,
    includeScopedFiles: false,
  });
  if (!loaded) throw error(404, "Project not found");

  // Serialized once and reused for both the tag and the body. The rows arrive in whatever
  // order SQLite hands them over, which is stable for a table nothing has written to — and
  // a table something *has* written to earns a new tag on the merits anyway. A reshuffle
  // that changed no data would cost one needless refresh, never a wrong one.
  const body = JSON.stringify(loaded.snapshot);
  const etag = snapshotEtag(body);
  // Recorded against the database signature as it stands *now*, after the read. A write
  // that landed while the queries ran therefore leaves a signature this tag is not
  // remembered under, so the next poll reads again rather than trusting a snapshot that
  // may already have been overtaken.
  rememberSnapshotEtag(dbUrl, projectId, etag);

  if (matchesEtag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  }

  return new Response(body, {
    headers: {
      "content-type": "application/json",
      etag,
      // The client does its own revalidation with the tag above. Letting the browser cache
      // as well would have it answer a 304 out of its own store, turning the exchange back
      // into the full-body 200 this exists to avoid.
      "cache-control": "no-store",
    },
  });
};
