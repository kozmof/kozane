# Kozane HTTP API Specification

## Overview

Kozane's browser UI is a SvelteKit application, and everything it does to a workspace it
does through the endpoints below. They are the same surface a script or a monitoring probe
reaches, so this document records the request and response shape each one implements today.

Scope: the JSON endpoints, meaning every `+server.ts` under `src/routes`. Page routes
(`/`, `/[namespaceId]`, `/map`, `/tags`, `/login`) render HTML and are covered by
[the browser UI handbook](../docs/browser-ui-handbook.md); the login form action is
described under [Authentication](#authentication) rather than given a section here.

`src/routes/spec.test.ts` checks this document against the route tree in both directions, so
an endpoint added, removed, or given another method fails the suite rather than quietly
leaving the spec behind.

---

## Conventions

### Namespace scoping

Every endpoint but `/health` is addressed under a namespace: `/[namespaceId]/api/...`. The
namespace in the URL is what the request acts within, and a row belonging to another
namespace is refused rather than acted on. Scopes are the one exception — they are
cross-namespace by design, so `POST /[namespaceId]/api/scopes` ignores the namespace in the
path and creates a scope the whole workspace can reach.

### Authentication

Once `.kozane/api.json` exists, every request needs the key. API clients send
`Authorization: Bearer <key>` or `X-API-Key: <key>`; browsers hold it in the
`kozane_api_key` cookie, which the login page's form action sets. A request without a valid
key is answered `401` with `WWW-Authenticate: Bearer realm="Kozane"`, except a top-level
browser navigation, which is redirected (`303`) to `/login?next=…`. Repeated failures from
one client address are throttled with `429` and a `Retry-After` header. A workspace with no
key file authenticates nobody and answers every request. See
[the security matrix](../docs/security-matrix.md).

### Request bodies

Every endpoint that takes a body takes exactly one JSON object. A body that is not valid
JSON is `400 Request body must be valid JSON`; one that parses to an array or a scalar is
`400 Request body must be a JSON object`.

Names (`name` fields) are trimmed, must be non-blank, and are at most 255 characters. Card
text is at most the workspace's configured `content.max` (default 10,000 characters). Id
arrays must contain non-empty strings, must not repeat an id, and must hold at most 2,000
items — an oversized list is refused as a list rather than partway into a statement.

Positions are clamped to the workspace's canvas bounds rather than refused; a card dragged
past the edge still means to land somewhere. Widths are refused instead, because a width out
of range is a caller with the wrong units.

### Responses

A write that has nothing to report answers `{"ok": true}`. Endpoints that clamp or
compute what they stored answer with the stored row instead, so a client cannot draw
something the server did not save.

Errors are SvelteKit errors: the status code, and a message a client may show. The statuses
these endpoints use:

| Status        | Meaning                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `400`         | The body is malformed, or names a row this namespace does not have                                                              |
| `401` / `429` | See [Authentication](#authentication)                                                                                           |
| `403`         | The file or directory cannot be read                                                                                            |
| `404`         | The resource the URL names does not exist                                                                                       |
| `409`         | The file changed on disk since it was read, or the directory already exists                                                     |
| `413` / `415` | The file is too large, or is not UTF-8 text                                                                                     |
| `426`         | A remote binding was reached over plain HTTP                                                                                    |
| `500`         | An unexpected failure; the cause is logged, not returned                                                                        |
| `503`         | The workspace is unavailable — no workspace, an unreadable key file, a database behind the schema, or another server holding it |

The distinction between `400` and `404` is deliberate and consistent: a route naming a
single resource in its path answers `404` when that resource is absent, because the resource
_is_ the URL. A batch route names no resource but the namespace, which exists, so an id it
cannot act on is a bad request.

---

## Cards

### `POST /[namespaceId]/api/cards`

Creates one card.

Body: `partitionId` (required), `content` (required, trimmed, non-blank), `posX`, `posY`,
`zIndex` (integer), `scopeId`, `layerId`. Omitting `layerId` lands the card on the
namespace's default layer; naming a layer the namespace does not have is refused rather than
redirected to the default, because a card that quietly lands elsewhere is invisible to the
client that asked for it. `scopeId`, when given, adds the new card to that scope in the same
transaction.

Answers the whole stored card — `id`, `partitionId`, `layerId`, `content`, the clamped
`posX`/`posY`, `zIndex`, and `taskspaceId`, `glueId`, `width` as `null`.

`400` for a missing or over-long field, an unknown partition, an unknown scope, a layer not
in this namespace, or a namespace with no default layer.

### `PATCH /[namespaceId]/api/cards`

Moves many cards at once — what a drag of a selection sends.

Body: `positions`, a non-empty array of `{ cardId, posX, posY }` with unique `cardId`s and
finite numbers. Positions are clamped to the canvas.

`400` for a malformed entry, a repeated `cardId`, more than 2,000 entries, or a card that is
not this namespace's.

### `DELETE /[namespaceId]/api/cards`

Deletes many cards. Body: `cardIds`. A glue group left with one member is dissolved in the
same transaction.

`400` when any id is not this namespace's.

### `PATCH /[namespaceId]/api/cards/[cardId]`

Edits one card. Every field is optional, and a body naming none of them is
`400 No fields to update`.

Body: `content` (trimmed; blank is refused), `partitionId`, `layerId`, `posX`, `posY`,
`zIndex` (integer), `width` (integer within 40–1200, or `null` to drop the card's own width
and follow `ui.defaultCardWidth`).

Only a change of `content` moves the card's `updatedAt`. A card dragged, resized, restacked,
or moved between partitions and layers keeps the timestamp it had — that interval is what
`kozane card list --sort gap` reports, and arranging the board must not reset it. Text that
arrives unchanged does not count either.

`404` when the card is not this namespace's. `400` for an unknown destination partition or
layer, a non-integer `zIndex`, or an out-of-range `width`.

### `DELETE /[namespaceId]/api/cards/[cardId]`

Deletes one card, dissolving a glue group it would leave with a single member. `404` when
the card is not this namespace's.

### `PATCH /[namespaceId]/api/cards/partition`

Moves many cards to one partition. Body: `partitionId`, `cardIds`.

`400` naming which of the two was wrong: the partition, or the cards.

### `PATCH /[namespaceId]/api/cards/layer`

Moves many cards to one layer. Body: `layerId`, `cardIds`.

Answers `{ ok: true, stacking: [{ cardId, zIndex }] }`. Arriving cards are restacked above
the target layer's own, so the client is told what they ended up with rather than left
holding a `zIndex` from the layer they came from.

### `POST /[namespaceId]/api/cards/move`

Moves many cards to another namespace, with their partition and layer resolved on the far
side. Body: `targetNamespaceId`, `cardIds`.

`400` when the target is the source, or when the cards are not this namespace's.

### `POST /[namespaceId]/api/cards/squash`

Replaces one card with a card per segment of its text, inserting the pieces, carrying the
original's scope memberships over, and removing it — all or none. Body: `cardId`.

The split pattern is the server's own, the same one `kozane card squash` uses. It is
deliberately not a request field: an arbitrary regular expression from a body is a cost this
endpoint has no reason to take on.

Answers `{ cards: [...] }` as whole rows, positions laid out and clamped, each with
`glueId: null` — the pieces start unglued.

`400` when the card is not this namespace's, when its text does not split into more than one
card, or when it splits into more than 2,000.

---

## Glue

### `POST /[namespaceId]/api/glues`

Glues cards into one group, so a drag of any of them moves all. Body: `cardIds`, at least
two. Answers `{ glueId }`. Cards already in other groups are moved into this one.

`400` when fewer than two ids are named, or when any is not this namespace's.

### `DELETE /[namespaceId]/api/glues`

Ungroups cards. Body: `cardIds`. Answers `{ ok: true, clearedCardIds }` — the cards that
actually left a group, which is what lets the board update only those. A group left with one
member is dissolved.

---

## Partitions

### `POST /[namespaceId]/api/partitions`

Creates a partition. Body: `name`. Answers `{ id }`.

`400` for a duplicate name within the namespace; `404` when the namespace does not exist.

### `PATCH /[namespaceId]/api/partitions/[partitionId]`

Renames a partition. Body: `name`. `404` when it is not this namespace's, `400` for a
duplicate name.

### `DELETE /[namespaceId]/api/partitions/[partitionId]`

Deletes a partition, moving its cards to the namespace's default partition first — the
cards are not deleted with it. Answers `{ ok: true, defaultPartitionId }`.

`400` for the default partition, which cannot be deleted. `404` when it is not this
namespace's.

---

## Layers

### `POST /[namespaceId]/api/layers`

Creates a layer at the top of the stack. Body: `name`. Answers `{ id, name, position,
isDefault: false }`.

`400` for a duplicate name within the namespace; `404` when the namespace does not exist.

### `PATCH /[namespaceId]/api/layers`

Renumbers the namespace's layers from a full bottom-to-top ordering. Body: `layerIds`,
naming every layer of the namespace exactly once.

`400` for a repeated id, an id belonging to another namespace, or a list that no longer
matches the namespace's layers — that last one is the case a reload fixes, and it says so.

### `PATCH /[namespaceId]/api/layers/[layerId]`

Renames a layer. Body: `name`. `404` when it is not this namespace's, `400` for a duplicate
name.

### `DELETE /[namespaceId]/api/layers/[layerId]`

Deletes a layer, moving its cards to the namespace's default layer first. Answers
`{ ok: true, defaultLayerId }`.

`400` for the default layer, which cannot be deleted. `404` when it is not this namespace's.

---

## Scopes

### `POST /[namespaceId]/api/scopes`

Creates a scope. Body: `name`. Answers `{ id }`.

The namespace in the path is not used: a scope is cross-namespace, placed by what refers to
it rather than by a column. A new scope refers to nothing yet, so every board draws it until
a card or taskspace places it.

`400` for a name already in use anywhere in the workspace.

### `DELETE /[namespaceId]/api/scopes/[scopeId]`

Deletes a scope. Taskspaces that were in it are kept and become unattached.

`404` when the scope is not one this namespace draws.

### `POST /[namespaceId]/api/scopes/[scopeId]/members`

Adds cards to a scope. Body: `cardIds`. `400` naming which was wrong — the scope, or the
cards.

### `DELETE /[namespaceId]/api/scopes/[scopeId]/members`

Removes cards from a scope, the ones belonging to this namespace. Body: `cardIds`.

---

## Warps

### `POST /[namespaceId]/api/warps`

Saves a place on the canvas the arrow keys can move the viewport to. Body: `posX`, `posY`,
both required. Both are clamped to the canvas and rounded to integers — a warp outside it
would scroll to a place the viewport can never reach.

Answers the whole stored warp. `404` when the namespace does not exist.

### `DELETE /[namespaceId]/api/warps/[warpId]`

Deletes a warp. `404` when it is not this namespace's.

### `GET /[namespaceId]/api/warp-directory`

Every namespace's warps, as the palette lists them, each with a hint naming the card nearest
it. Fetched when the palette opens rather than on the snapshot poll: a warp set in another
namespace is rare enough that re-reading every namespace's cards once a second would be
waste.

`404` when the namespace does not exist.

---

## Taskspaces

### `POST /[namespaceId]/api/taskspaces`

Creates a taskspace: the record, its directory under the workspace's taskspace directory,
and the `.taskspace.json` marker inside it. Body: `name`, `scopeId` (both required).

The directory is claimed atomically, and a failure anywhere in the sequence removes only
what this request created — the record, the marker, and the directory, never recursing into
it.

Answers `{ id, path, pathKind: "workspace_relative" }`. A taskspace outside the workspace
root can only be made by the CLI (`kozane taskspace create --dir`).

`400` when the scope does not exist, or when the name would place the directory outside the
workspace root. `404` when the namespace does not exist. `409` when the directory is already
there. `503` when there is no workspace.

### `GET /[namespaceId]/api/taskspaces/[taskspaceId]/files`

One directory of a taskspace, as the file panel draws it. Query: `path`, a `/`-separated
path relative to the taskspace root; omitted, the root itself.

Names and metadata only — this endpoint never reads a file. Dot-entries are never listed or
recursed into, so `.git` and a stray `.env` stay off the panel. Symlinks are listed as
themselves and never followed. A directory past 5,000 entries is answered truncated, and
says so.

The taskspace is looked up under the namespace's own filter, so a namespace's endpoint
answers only about the taskspaces its board draws. What keeps a request inside the directory
is the containment check below it, which holds however the row was found: the requested path
is checked before resolution, so `..` cannot walk out, and again after, so a symlink cannot
either.

`400` for a path that leaves the taskspace, `403` when it cannot be read, `404` for an
unknown namespace, taskspace, or directory, `503` when there is no workspace.

### `GET /[namespaceId]/api/taskspaces/[taskspaceId]/file`

The text of one file. Query: `path`.

A separate endpoint from the listing rather than a mode of it, so "names and metadata only"
stays true of that route without qualification. What may be read here is narrower than what
is listed there: regular files only, under 1MB, valid UTF-8, never a dot-entry.

Answers the content and the signature it was read at, which a save sends back.

`413` when the file is too large, `415` when it is not text, otherwise as the listing above.

### `PUT /[namespaceId]/api/taskspaces/[taskspaceId]/file`

Saves text back over an existing file. Body: `path`, `content`, `signature` — all three
required, and `signature` may be `null` but may not be left out.

`signature` is what the editor read the file at, compared against the file as it is now, so
a save that would discard a change made on disk since then is refused. Leaving it out is not
a way to force the write; it is a `400`.

`409` when the file changed underneath the editor. Otherwise as above.

---

## Board data

### `GET /[namespaceId]/api/snapshot`

Everything a board draws — cards, partitions, layers, warps, scopes, scope and glue
relations, taskspaces — as one object. The page load and this endpoint run the same read, so
the board a poll replaces cannot be assembled differently from the board it replaces.

Polled once a second per open tab. Send back the `ETag` as `If-None-Match` and an unchanged
board answers `304` with no body. The tag is a hash of the response bytes; a gate in front
of the read compares the database file's identity first, so an unchanged workspace is
answered without running the queries at all.

`Cache-Control: no-store` throughout: the client revalidates with the tag itself, and letting
the browser cache as well would turn a `304` back into the full response this exists to
avoid.

`404` when the namespace does not exist.

---

## Health

### `GET /health`

Readiness, as a probe reads it. Answers `{ status, cpuUsage, memoryUsage }` — `200` with
`status: "ok"` when the database answers a query, `503` with `status: "error"` and an
`error` field when it does not.

Alert on `status` rather than on the status code alone. The cause of a failure is written to
the log, not to the response.

This endpoint sits behind the same authentication as everything else, so a monitoring probe
on a workspace with a key has to send it too.
