import { createHash } from "node:crypto";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadProjectSnapshot } from "../../lib/project-snapshot";

/**
 * A tag for the exact bytes of a snapshot. Derived from the payload rather than from a
 * revision the writers maintain, and that is the point: the CLI writes to the same database
 * file without passing through this server at all, so there is no counter here that could
 * see every change. A tag computed from the data cannot miss one, and no future write path
 * has to remember to bump anything.
 *
 * Not a security boundary — it says "these bytes differ", nothing more.
 */
function snapshotEtag(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}

/**
 * Whether the client already holds this exact snapshot. A weak validator is accepted
 * because the tag only ever has to answer that question, and `*` matches anything the
 * server would send.
 */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

export const GET: RequestHandler = async ({ locals, params, request }) => {
  // The same read the page load makes, so the board the poll replaces cannot be assembled
  // differently from the board it replaces. `path` is sent as stored — unlike the static
  // export, which nulls it; see the note on `includeTaskspacePaths`.
  const loaded = await loadProjectSnapshot({
    db: locals.db,
    projectId: params.projectId,
    includeTaskspacePaths: true,
  });
  if (!loaded) throw error(404, "Project not found");

  // Serialized once and reused for both the tag and the body. The rows arrive in whatever
  // order SQLite hands them over, which is stable for a table nothing has written to — and
  // a table something *has* written to earns a new tag on the merits anyway. A reshuffle
  // that changed no data would cost one needless refresh, never a wrong one.
  const body = JSON.stringify(loaded.snapshot);
  const etag = snapshotEtag(body);

  // The board is polled once a second for as long as it is open. Almost every one of those
  // polls finds nothing new, and answering them with the whole board again is what made an
  // idle page re-parse and re-render itself every second.
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
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
