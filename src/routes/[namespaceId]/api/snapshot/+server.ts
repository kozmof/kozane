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
  // Remembered only if the signature taken before the read still stands after it. A write
  // that landed while the queries ran leaves this tag unremembered, so the next poll reads
  // again rather than being answered 304 with a snapshot that write had overtaken.
  rememberSnapshotEtag(dbUrl, namespaceId, etag, readFrom);

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
