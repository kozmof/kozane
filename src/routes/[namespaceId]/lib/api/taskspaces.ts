/** Taskspace requests: creating taskspaces and reading and writing their files. */
import { apiUrl, jsonRequest, type SaveOptions } from "./request.js";

export function createTaskspace(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspace: { name: string; scopeId: string },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/taskspaces"), "POST", taskspace);
}

/** Read one taskspace directory by relative path. An empty path names the root. */
export function fetchTaskspaceFiles(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
): Promise<Response> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return fetcher(apiUrl(namespaceId, `/taskspaces/${taskspaceId}/files${query}`));
}

/**
 * Create an empty file and return its readable state. Existing names return 409. Write
 * content through {@link saveTaskspaceFile}.
 */
export function createTaskspaceFile(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/taskspaces/${taskspaceId}/file`), "POST", {
    path,
  });
}

/**
 * Create a taskspace directory through the `files` route and return its empty listing.
 * Return `404` if the parent is missing or `409` if the name is already taken.
 */
export function createTaskspaceFolder(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/taskspaces/${taskspaceId}/files`), "POST", {
    path,
  });
}

/**
 * Fetch taskspace file text for the editor. {@link fetchTaskspaceFiles} uses a separate
 * endpoint for names and metadata.
 */
export function fetchTaskspaceFile(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  const query = `?path=${encodeURIComponent(path)}`;
  return fetcher(apiUrl(namespaceId, `/taskspaces/${taskspaceId}/file${query}`), { signal });
}

/**
 * Save text with the signature from the last read. The server returns 409 if the file changed
 * in the meantime. `keepalive` lets a small save outlive the page, as when the tab closes.
 */
export function saveTaskspaceFile(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  file: { path: string; content: string; signature: string | null },
  options: SaveOptions = {},
): Promise<Response> {
  return jsonRequest(
    fetcher,
    apiUrl(namespaceId, `/taskspaces/${taskspaceId}/file`),
    "PUT",
    file,
    options,
  );
}
