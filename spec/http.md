# Kozane HTTP API reference

This reference covers JSON endpoints used by browser and API clients.
For HTML pages, see the [browser UI handbook](../docs/browser-ui-handbook.md).
Endpoint coverage is checked by `src/routes/spec.test.ts`.

## Conventions

### Namespace scoping

Endpoints use `/[namespaceId]/api/...`, except `/health`.
Requests are limited to the named namespace. Scope creation is workspace-wide
and ignores the namespace in its path.

### Authentication

When `.kozane/api.json` exists, send `Authorization: Bearer <key>` or
`X-API-Key: <key>`. Browsers use the `kozane_api_key` cookie set by login.

Invalid credentials return 401 with `WWW-Authenticate: Bearer realm="Kozane"`.
Top-level browser navigations instead receive 303 to `/login?next=…`.
Repeated failures per client address return 429 with `Retry-After`.
Keyless local workspaces permit unauthenticated access subject to host checks.
See the [security matrix](../docs/security-matrix.md).

### Request bodies

Send one JSON object with `Content-Type: application/json`.

| Invalid input                 | Response                                            |
| ----------------------------- | --------------------------------------------------- |
| Missing or other content type | `415 Request body must be sent as application/json` |
| Invalid JSON                  | `400 Request body must be valid JSON`               |
| Array or scalar               | `400 Request body must be a JSON object`            |

Names are trimmed, non-blank, and at most 255 characters. Card text is limited by
`ui.contentMax`, defaulting to 200,000 UTF-16 code units. ID arrays contain unique,
non-empty strings and at most 2,000 items. Invalid batches fail as a whole.
Positions are clamped to canvas bounds. Out-of-range widths are refused.

### Responses

A write that has nothing to report answers `{"ok": true}`. Endpoints that clamp or
compute what they stored answer with the stored row instead, so a client cannot draw
something the server did not save.

Errors are SvelteKit errors with a status code and a message a client may show. These endpoints
use the following statuses.

| Status        | Meaning                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`         | The body is malformed, or names a row this namespace does not have                                                                            |
| `401` / `429` | See [Authentication](#authentication)                                                                                                         |
| `403`         | The file or directory cannot be read                                                                                                          |
| `404`         | The resource the URL names does not exist                                                                                                     |
| `409`         | The file changed on disk since it was read, or the name is already taken                                                                      |
| `413` / `415` | The file is too large, or is not UTF-8 text                                                                                                   |
| `426`         | A remote binding was reached over plain HTTP                                                                                                  |
| `500`         | An unexpected failure, with the cause logged rather than returned                                                                             |
| `503`         | The workspace is unavailable because it is missing, its key file is unreadable, its database is behind the schema, or another server holds it |

The distinction between `400` and `404` is deliberate and consistent. A route naming a
single resource in its path answers `404` when that resource is absent, because the resource
is the URL. A batch route names no resource but the namespace, which exists, so an id it
cannot act on is a bad request.

## Cards

### `POST /[namespaceId]/api/cards`

Create a card.

Body fields are `partitionId` and `content` (required, text trimmed and non-blank),
plus optional `posX`, `posY`, `zIndex` (integer), `scopeId`, `layerId`, and `inventoryId`.
Omitting the layer uses the namespace default. Scope membership is atomic with creation.
With `inventoryId`, the card is stored in that inventory's first free slot in the same
transaction.

Return the stored card with `id`, `partitionId`, `layerId`, `content`, clamped
`posX` / `posY`, `zIndex`, null `taskspaceId`, `glueId`, and `width`, and the
`inventoryId` and `inventorySlot` it was stored at, or null for both.

Return 400 for missing or oversized fields, unknown partition or scope, a layer
outside this namespace, an inventory outside this namespace, or a missing default layer.
A refused card is not created.

### `PATCH /[namespaceId]/api/cards`

Move cards in one batch.

Body: `positions`, a non-empty array of `{ cardId, posX, posY }` with unique `cardId`s and
finite numbers. Positions are clamped to the canvas.

`400` for a malformed entry, a repeated `cardId`, more than 2,000 entries, or a card that is
not this namespace's.

### `DELETE /[namespaceId]/api/cards`

Deletes many cards. Body: `cardIds`. A glue group left with one member is dissolved in the
same transaction.

`400` when any id is not this namespace's.

### `PATCH /[namespaceId]/api/cards/[cardId]`

Edit a card. All fields are optional, but an empty update returns
`400 No fields to update`.

Body fields are `content` (trimmed, non-blank), `partitionId`, `layerId`,
`posX`, `posY`, `zIndex` (integer), and `width` (integer from 40 to 1200,
or null to follow `ui.defaultCardWidth`). Only changed text updates `updatedAt`.

Changing layers stacks the card above destination cards. An explicit `zIndex`
overrides that value. Return `{ ok: true, stacking: [{ cardId, zIndex }] }`,
with empty `stacking` unless the layer changed.

Return 404 for a card outside this namespace, or 400 for an invalid destination,
non-integer `zIndex`, or out-of-range width.

### `DELETE /[namespaceId]/api/cards/[cardId]`

Deletes one card, dissolving a glue group it would leave with a single member. `404` when
the card is not this namespace's.

### `PATCH /[namespaceId]/api/cards/partition`

Moves many cards to one partition. Body: `partitionId`, `cardIds`.

`400` naming which of the two was wrong, the partition or the cards.

### `PATCH /[namespaceId]/api/cards/layer`

Move cards to a layer. Body fields are `layerId` and `cardIds`.
Stack arriving cards above destination cards and return
`{ ok: true, stacking: [{ cardId, zIndex }] }`.

### `PATCH /[namespaceId]/api/cards/stacking`

Restack cards within their own layers. Body fields are `cardIds` and
`direction` (`"front"` or `"back"`). Groups may span layers.
Return `{ ok: true, stacking: [{ cardId, zIndex }] }`.
Return 400 for invalid cards or direction.

### `POST /[namespaceId]/api/cards/move`

Moves many cards to another namespace, with their partition and layer resolved on the far
side. Body: `targetNamespaceId`, `cardIds`.

Moved cards are restacked above the cards already on each destination layer and leave their
glue groups. A card linked to a taskspace placed in another namespace loses that link.
Links to unplaced taskspaces, and to taskspaces of the target namespace, are kept.

`400` when the target is the source, or when the cards are not this namespace's.

### `POST /[namespaceId]/api/cards/squash`

Atomically replace a card with one card per text segment, preserving its scopes.
Body requires `cardId`. The separator matches the CLI default and cannot be customized.

Return `{ cards: [...], stacking: [{ cardId, zIndex }] }`.
Pieces are complete rows with laid-out, clamped positions and null `glueId`.
They take consecutive stacking values from the original. Cards above them are
raised and included in `stacking`.

Return 400 for a card outside this namespace, fewer than two pieces, or more
than 2,000 pieces.

## Glue

### `POST /[namespaceId]/api/glues`

Glues cards into one group, so a drag of any of them moves all. Body: `cardIds`, at least
two. Answers `{ glueId, clearedCardIds }`. Cards already in other groups are moved into this
one. A group left with one member is dissolved, and `clearedCardIds` names those leftover
cards so the board can clear them.

`400` when fewer than two ids are named, or when any is not this namespace's.

### `DELETE /[namespaceId]/api/glues`

Ungroups cards. Body: `cardIds`. Answers `{ ok: true, clearedCardIds }`, the cards that
actually left a group, so the board can update only those. A group left with one
member is dissolved.

## Partitions

### `POST /[namespaceId]/api/partitions`

Creates a partition. Body: `name`. Answers `{ id }`.

`400` for a duplicate name within the namespace. `404` when the namespace does not exist.

### `PATCH /[namespaceId]/api/partitions/[partitionId]`

Renames a partition. Body: `name`. `404` when it is not this namespace's, `400` for a
duplicate name.

### `DELETE /[namespaceId]/api/partitions/[partitionId]`

Deletes a partition, moving its cards to the namespace's default partition first. The
cards are not deleted with it. Answers `{ ok: true, defaultPartitionId }`.

`400` for the default partition, which cannot be deleted. `404` when it is not this
namespace's.

## Layers

### `POST /[namespaceId]/api/layers`

Creates a layer at the top of the stack. Body: `name`. Answers `{ id, name, position,
isDefault: false }`.

`400` for a duplicate name within the namespace. `404` when the namespace does not exist.

### `PATCH /[namespaceId]/api/layers`

Renumbers the namespace's layers from a full bottom-to-top ordering. Body: `layerIds`,
naming every layer of the namespace exactly once.

`400` for a repeated id, an id belonging to another namespace, or a list that no longer
matches the namespace's layers. A reload fixes that last case, and the error says so.

### `PATCH /[namespaceId]/api/layers/[layerId]`

Renames a layer. Body: `name`. `404` when it is not this namespace's, `400` for a duplicate
name.

### `DELETE /[namespaceId]/api/layers/[layerId]`

Deletes a layer, moving its cards to the namespace's default layer first. Answers
`{ ok: true, defaultLayerId }`.

`400` for the default layer, which cannot be deleted. `404` when it is not this namespace's.

## Scopes

### `POST /[namespaceId]/api/scopes`

Create a workspace-wide scope. Body requires `name`. Return `{ id }`.
The namespace path parameter is ignored. An unused scope appears on every board.
Return 400 for a name already used in the workspace.

### `DELETE /[namespaceId]/api/scopes/[scopeId]`

Deletes a scope. Taskspaces that were in it are kept and become unattached.

`404` when the scope is not one this namespace draws.

### `POST /[namespaceId]/api/scopes/[scopeId]/members`

Adds cards to a scope. Body: `cardIds`. `400` naming which was wrong, the scope or the
cards.

### `DELETE /[namespaceId]/api/scopes/[scopeId]/members`

Removes cards from a scope, the ones belonging to this namespace. Body: `cardIds`.

### `POST /[namespaceId]/api/scopes/[scopeId]/areas`

Add a scope frame on this board. Body requires `posX`, `posY`, `width`,
and `height`. Return the complete stored row.

A scope may have multiple frames per board and across boards. Round coordinates,
clamp the whole rectangle to the canvas, and enforce a 120-pixel minimum per side.
Membership is updated separately through the members endpoints by the browser,
which calculates card overlap.

Return 400 for missing fields or 404 for an unknown scope.

### `PATCH /[namespaceId]/api/scopes/[scopeId]/areas/[areaId]`

Move or resize a frame. Require the same complete rectangle as POST, with the
same clamping, and return the stored row. Namespace and scope must match the frame.
Return 400 for missing fields or 404 for a frame outside this board and scope.

### `DELETE /[namespaceId]/api/scopes/[scopeId]/areas/[areaId]`

Takes one frame off the board. The scope keeps every card in it, and keeps its other frames.

`404` when this board has no such frame.

## Warps

### `POST /[namespaceId]/api/warps`

Create a saved canvas position. Body requires `posX` and `posY`, clamped to
the canvas and rounded to integers. Return the stored warp.
Return 404 for an unknown namespace.

### `PATCH /[namespaceId]/api/warps/[warpId]`

Move a warp. Body requires `posX` and `posY`, clamped and rounded as in POST.
Preserve creation order and return the stored warp.
Return 404 for a warp outside this namespace.

### `DELETE /[namespaceId]/api/warps/[warpId]`

Deletes a warp. `404` when it is not this namespace's.

### `GET /[namespaceId]/api/warp-directory`

Return warps from every namespace, each with a hint naming the nearest card.
Fetched when the warp picker opens. Return 404 for an unknown namespace.

## Inventories

An inventory is a grid that stores cards. Slots are numbered from 0, left to right and
top to bottom. A stored card has `inventoryId` and `inventorySlot` set and keeps its canvas
`posX` / `posY` for when it comes back out.

### `POST /[namespaceId]/api/inventories`

Create an inventory. Body requires `posX` and `posY`, clamped to the canvas and rounded
to integers. Optional `name` is trimmed and may be empty.
Return the stored inventory. Return 404 for an unknown namespace.

### `PATCH /[namespaceId]/api/inventories/[inventoryId]`

Move or rename an inventory. Body takes `posX` and `posY` together, `name`, or both.
Return the stored inventory.
Return 400 for an empty body or only one coordinate, and 404 for an inventory outside
this namespace.

### `DELETE /[namespaceId]/api/inventories/[inventoryId]`

Delete an inventory. Its cards return to the canvas at the positions they had before
they were stored. Return `{ releasedCardIds }`.
Return 404 for an inventory outside this namespace.

### `POST /[namespaceId]/api/inventories/[inventoryId]/cards`

Store cards. Body requires `cardIds` and takes an optional integer `slot` from 0 to 9999.

- One card with a `slot` takes that slot. A card already there swaps with it when both are
  in this inventory, and otherwise moves to the first free slot.
- Otherwise cards fill free slots in order, starting from `slot` or from 0. Cards already
  in this inventory stay where they are.

A card leaves its glue group when it is stored. A group left with one member is dissolved.
Return `{ placements, clearedCardIds }`, where `placements` lists `{ cardId, inventoryId,
slot }` for every card whose slot changed and `clearedCardIds` lists the cards left without
a glue group.

Return 400 for an inventory or card outside this namespace, or a placement past slot 9999.

### `POST /[namespaceId]/api/inventories/take`

Return stored cards to the canvas. Body requires `cards`, an array of
`{ cardId, posX?, posY? }` with unique `cardId`s. A card given a position goes there,
clamped to the canvas. A card without one returns to where it was before it was stored.
Return `{ cards }` with the stored positions.

Return 400 for one coordinate without the other, a repeated `cardId`, or a card that is
not this namespace's.

## Taskspaces

### `POST /[namespaceId]/api/taskspaces`

Create a taskspace record, directory, and `.taskspace.json` marker.
Body requires `name` and `scopeId`. The directory is claimed atomically.
On failure, remove only entries created by this request.

Return `{ id, path, pathKind: "workspace_relative" }`.
Names must be one path segment, contain no `/`, `\`, or NUL, and not start
with a dot. External taskspaces require CLI `taskspace create --dir`.

Return 400 for an invalid name, unknown scope, or configured directory outside
the workspace, 404 for an unknown namespace, 409 for an existing directory,
or 503 without a workspace.

### `GET /[namespaceId]/api/taskspaces/[taskspaceId]/files`

List a taskspace directory. Optional query `path` is relative to its root and
uses `/` separators. Omit it to list the root.

Return names, kinds, sizes, and modification times without reading file contents.
Hide dot-entries, list symlinks without following them, and mark listings truncated
past 500 entries. Taskspaces must be visible on this namespace's board.

All taskspace file routes check containment before and after path resolution.
Return 400 for traversal, 403 for unreadable paths, 404 for unknown namespace,
taskspace, or directory, and 503 without a workspace.

### `POST /[namespaceId]/api/taskspaces/[taskspaceId]/files`

Create one directory. Body requires a taskspace-relative `path`.
Return 201 with the directory listing shape used by GET.
Do not create parents or replace entries. Return 404 for a missing parent and
409 for an existing file, directory, or symlink. Listing access rules also apply.

### `GET /[namespaceId]/api/taskspaces/[taskspaceId]/file`

Read a file. Query requires `path`. Return its content and read signature.
Only regular UTF-8 files up to 1 MB are allowed, with no dot-entries or symlinks.
Return 413 for oversized files and 415 for non-text files.
Other listing access rules and errors apply.

### `POST /[namespaceId]/api/taskspaces/[taskspaceId]/file`

Create one empty file. Body requires `path` and must not include `content`.
Return 201 with `path`, empty `content`, and `signature`.
Use PUT to save contents. Return 400 for supplied content, 409 for an existing
entry, or 404 for a missing parent. Other listing access rules apply.

### `PUT /[namespaceId]/api/taskspaces/[taskspaceId]/file`

Replace an existing file's text. Body requires `path`, `content`, and
`signature`. The signature may be null but cannot be omitted.
Return 409 if the file changed since it was read, or 400 for missing fields.
Other file read limits and access rules apply.

## Board data

### `GET /[namespaceId]/api/snapshot`

Return board data, including cards, partitions, layers, warps, inventories, scopes, scope
areas, scope and glue relations, and taskspaces. Stored cards are included with their
`inventoryId` and `inventorySlot`.

Send the response `ETag` as `If-None-Match` on subsequent requests. Unchanged
data returns 304 without a body. Responses use `Cache-Control: no-store`.
The browser polls once per second. Return 404 for an unknown namespace.

## Health

### `GET /health`

Return `{ status, cpuUsage, memoryUsage }`. A successful database query returns
200 with `status: "ok"`. Failure returns 503 with `status: "error"` and a fixed
`error` message. The underlying cause is logged.
Check `status` in monitoring. The endpoint uses the same authentication as other routes.
