import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { openedDbUrl } from "$db/client";
import {
  matchesEtag,
  rememberSnapshotEtag,
  snapshotEtag,
  snapshotReadSignature,
  unchangedSnapshotEtag,
} from "$lib/server/snapshot-etag";
import { loadNamespaceSnapshot } from "../../lib/namespace-snapshot.js";

export const GET: RequestHandler = async ({ locals, params, request }) => {
  const { namespaceId } = params;
  const ifNoneMatch = request.headers.get("if-none-match");
  const dbUrl = openedDbUrl();

  // Try the cached ETag before reading and serializing a snapshot. An unchanged database
  // signature can answer recurring polls without repeating those queries.
  const unchanged = unchangedSnapshotEtag(dbUrl, namespaceId);
  if (unchanged && matchesEtag(ifNoneMatch, unchanged)) {
    return new Response(null, {
      status: 304,
      headers: { etag: unchanged, "cache-control": "no-store" },
    });
  }

  // Share the page-load snapshot reader. Live polling includes stored taskspace paths, while
  // static export can omit them.
  const readFrom = snapshotReadSignature(dbUrl);
  const loaded = await loadNamespaceSnapshot({
    db: locals.db,
    namespaceId,
    includeTaskspacePaths: true,
    includeScopes: true,
    includeScopedFiles: false,
  });
  if (!loaded) throw error(404, "Namespace not found");

  // Serialize once for both the body and ETag. An ordering-only change may cause an extra
  // refresh but cannot hide a data change.
  const body = JSON.stringify(loaded.snapshot);
  const etag = snapshotEtag(body);
  // Cache the ETag only if the database signature stayed unchanged during the read. A
  // concurrent write forces the next poll to assemble a fresh snapshot.
  rememberSnapshotEtag(dbUrl, namespaceId, etag, readFrom);

  if (matchesEtag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  }

  return new Response(body, {
    headers: {
      "content-type": "application/json",
      etag,
      // Let the client revalidate with the ETag. Browser caching could replace a 304 with a
      // cached 200 response and make the client process the full body again.
      "cache-control": "no-store",
    },
  });
};
