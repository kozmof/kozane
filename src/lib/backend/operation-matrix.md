# Backend operation matrix

Use the exported declarations in [contract.ts](contract.ts), [resources.ts](resources.ts) and [taskspaces-api.ts](taskspaces-api.ts) for exact call and result types. This matrix records the implemented read and taskspace surface. Domain mutation rows and the LocalBackend contract runner remain pending under P2-01. This document does not establish Gate 3 completion.

## Shared rules

Identifiers are strings. A supplied namespace identifies the board, and taskspace IDs must be visible there. Optional fields accept omission or undefined. Null is accepted only where the exported type includes it. No operation automatically replays a rejected mutation.

Reads do not publish invalidations. Successful HTTP mutations publish all five datasets (`snapshot`, `tags`, `map`, `namespaces`, `warpDirectory`) after the response succeeds, including when response decoding fails afterward. Failed requests publish nothing. Static mutations reject with `read_only` and publish nothing.

HTTP requests share authentication, permission, throttling and network handling. Statuses 401, 403 and 429 are authoritative. Other errors use the allowlisted `X-Kozane-Error-Code` header or the status fallback. See the [HTTP compatibility mappings](../../../docs/backend-separation/http-error-compatibility.md). Static reads reject missing records with `not_found` and datasets absent from an export with `unavailable`.

Keepalive is supported only by methods that accept `MutationOptions`. It requests fetch keepalive for a JSON body within the 60 KiB transport budget. It does not guarantee delivery. Reads and other methods below do not accept it.

## Dataset reads

No write capability is required. All results are promises of the named type. Namespace metadata uses direct database reads. Snapshot rows share one read transaction. Tags, map and warp-directory aggregation currently use multiple database reads and may include Node enrichment outside a database transaction. Consolidating those read boundaries remains pending in Phase 1. Static reads use embedded data and open no transaction.

| Method | Identifiers and input semantics | Result | HTTP endpoint | Specific failures and test coverage |
| --- | --- | --- | --- | --- |
| `snapshot` | Namespace required. Omit `SnapshotReadOptions.validator` for full data. Validators are opaque and scoped to backend instance, namespace and generation. Null is invalid. | `SnapshotResult` with changed data or unchanged status | `GET /:namespaceId/api/snapshot`, conditional ETag support | Missing namespace, malformed snapshot or conditional response. `backend-entry.test.ts`, `snapshot-validators.test.ts`, `http-backend.test.ts` and `static-backend.test.ts`. |
| `namespaces.list` | No input. Empty workspace returns an empty list. | `NamespaceListResult` | `GET /api/namespaces` | Transport or database failure. `backend-entry.test.ts` and namespace route tests. |
| `namespaces.get` | Namespace required. | `NamespaceGetResult` | `GET /api/namespaces/:namespaceId` | Missing namespace. `backend-entry.test.ts` and namespace route tests. |
| `tags.get` | Optional namespace. Omission gathers the workspace. An unknown supplied namespace rejects. Null is invalid. | `TagsResult` | `GET /api/tags`, optional `namespaceId` query | Missing namespace, malformed dataset. Static exports retain embedded scan limits. `backend-entry.test.ts`, `decoders/tags.test.ts`, `static-backend.test.ts` and tags route tests. |
| `map.get` | No input. | `MapResult` | `GET /api/map` | Malformed dataset. `backend-entry.test.ts`, `decoders/map.test.ts`, `static-backend.test.ts` and map route tests. |
| `warpDirectory.get` | Current namespace required. Returns other namespaces' warp entries. | `WarpDirectoryResult` | `GET /:namespaceId/api/warp-directory` | Missing namespace. `backend-entry.test.ts`, `http-backend.test.ts`, `static-backend.test.ts` and warp-directory route tests. |

## Taskspaces

The optional `taskspaces` API exists only when `capabilities.taskspaces` is true. Node supplies filesystem operations. Static exports with embedded files expose the same interface for reads and reject all writes. LocalBackend does not supply taskspaces.

Paths are relative to the trusted taskspace directory. An empty listing path names its root. Node services validate containment, entry names, file sizes, text encoding and symlinks. File mutations run in a per-taskspace queue, resolving the directory inside the queue. This is filesystem serialization, not a database transaction. Taskspace creation inserts the database record then claims the directory, deleting the record if claiming fails. Rename/removal coordinate database and filesystem changes through Node services rather than one atomic filesystem/database transaction.

Node file errors retain HTTP 400 for invalid paths, 404 for missing entries, 403 for forbidden access, 409 for existing entries or stale signatures, 413 for oversized files and 415 for nontext files. Their backend codes use the HTTP status fallback. Node lifecycle errors retain their existing operation-specific statuses and wording. Static skipped files reject with `limit` for size/budget exclusions and `unavailable` for nontext/unreadable exclusions. A cancelled static file read rejects with `unavailable`.

Every write requires writable capability, publishes all datasets on HTTP success and rejects with `read_only` on StaticBackend. Other than `saveFile`, taskspace methods do not support keepalive.

| Method | Required identifiers and input | Omission and null semantics | Result | HTTP endpoint | Classification and specific coverage |
| --- | --- | --- | --- | --- | --- |
| `taskspaces.create` | Namespace, `TaskspaceCreateInput` with name and scope ID | Neither field may be omitted or null | `TaskspaceCreateResult` | `POST /:namespaceId/api/taskspaces` | Node adapter only. Missing namespace/scope, invalid configuration/name, directory conflict and claim rollback. Taskspace collection route tests. |
| `taskspaces.rename` | Namespace, taskspace, `TaskspaceRenameInput` with name | Name required and nonnull | `TaskspaceRenameResult` | `PATCH /:namespaceId/api/taskspaces/:taskspaceId` | Node adapter only. Missing taskspace, name/path conflict and filesystem failure. Taskspace item route tests. |
| `taskspaces.remove` | Namespace and taskspace | No body | `TaskspaceRemoveResult` including directory outcome | `DELETE /:namespaceId/api/taskspaces/:taskspaceId` | Node adapter only. Missing taskspace and directory ownership/removal outcomes. Taskspace item route tests. |
| `taskspaces.createFile` | Namespace, taskspace, `TaskspaceCreateFileInput` with path | Content is not accepted. Create first, then save. | `TaskspaceCreateFileResult` with empty content and signature | `POST /:namespaceId/api/taskspaces/:taskspaceId/file` | Node adapter only. Invalid path, existing entry, forbidden access. File route tests and `http-backend.test.ts`. |
| `taskspaces.readFile` | Namespace, taskspace, path | Optional `TaskspaceReadFileOptions.signal`. No signature input. | `TaskspaceReadFileResult`. Static signature is null. | `GET /:namespaceId/api/taskspaces/:taskspaceId/file?path=...` | Shared embedded/live read case in `backend-entry.test.ts`. File route tests and `static-backend.test.ts` cover path, encoding, size and export exclusions. |
| `taskspaces.saveFile` | Namespace, taskspace, `TaskspaceSaveFileInput` with path, content and signature | Signature must be present, string or null. A mismatch rejects. Empty content is valid. Optional `MutationOptions.keepalive`. | `TaskspaceSaveFileResult` with new signature | `PUT /:namespaceId/api/taskspaces/:taskspaceId/file` | Node adapter only. Stale signature, missing file, encoding, size and atomic-save failures. File route tests and `http-backend.test.ts`. Shared read-only rejection in `backend-entry.test.ts`. |
| `taskspaces.list` | Namespace, taskspace, path | Empty path selects root. | `TaskspaceListResult`. Static entries have null modification times and may include truncation reason. | `GET /:namespaceId/api/taskspaces/:taskspaceId/files?path=...` | Shared embedded/live read case in `backend-entry.test.ts`. Directory route tests and `static-backend.test.ts` cover truncation and missing directories. |
| `taskspaces.createDirectory` | Namespace, taskspace, `TaskspaceCreateDirectoryInput` with path | Path required and nonnull | `TaskspaceCreateDirectoryResult` | `POST /:namespaceId/api/taskspaces/:taskspaceId/files` | Node adapter only. Invalid path, existing entry and forbidden access. Directory route tests and `http-backend.test.ts`. |
| `taskspaces.renameEntry` | Namespace, taskspace, `TaskspaceRenameEntryInput` with path and new name | Both fields required and nonnull | `TaskspaceRenameEntryResult` | `PATCH /:namespaceId/api/taskspaces/:taskspaceId/files` | Node adapter only. Invalid name, missing source, existing destination and forbidden access. Directory route tests and `http-backend.test.ts`. |
| `taskspaces.removeEntry` | Namespace, taskspace, path | Nonempty path required. No body. | `TaskspaceRemoveEntryResult` | `DELETE /:namespaceId/api/taskspaces/:taskspaceId/files?path=...` | Node adapter only. Root deletion refusal, missing entry and forbidden access. Directory route tests and `http-backend.test.ts`. |

The compiled [consumer fixture](../../test-utils/backend-inputs.typecheck.ts) calls every current resource method through the backend entry and checks invalid input examples. It runs under the project type check. Isolated packed-consumer verification remains a Phase 3 deliverable.
