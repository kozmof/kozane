# Action stamping write inventory

Stamping is not active. This inventory records write paths and contract gaps
for action stamping and restoration. Keep capture guards disabled until the
adapter prototype and restoration checks pass. Track progress in the
[task list](action-stamping-tasks.md).

## Contract declarations

`packages/core/src/actions/contracts.ts` declares version 1 invocation types for
all client writes and the existing namespace and scope administration operations.
Each envelope includes `args` for route and target values and `body` when the
operation accepts input. Transport options such as `keepalive` are not invocation
arguments. `scopes.create` retains the client's namespace argument even though
the underlying core service creates a workspace-wide scope.

The client classification is checked against these declarations during its build.
A client method declared as a write must have a core action kind. The focused
contract test checks this correspondence at runtime too.

`actions/invocation.ts` checks each envelope's complete routing arguments and body
presence before dispatch. It copies JSON-compatible input without applying domain
normalization. Service validation still owns content limits and resolved values.

`actions/registry.ts` requires replay handlers for syncable declarations and explicit
recovery handlers for local-only declarations. Registry selection checks the recorded
contract version against supported schema versions and returns
`action-contract-required` without entering a handler on incompatibility. Registry
descriptors and schema support are copied so callers cannot replace them afterward.
Intent replay requires a replay binding provider and cannot invoke file recovery.

The [execution scope](action-execution-scopes.md) now provides an opt-in root
transaction, sequential child dispatch, handler ownership and a failure latch.
Core `InTx` services share that latch, including failures before SQL.

The [composition API](action-composition.md) now defines `system.compose` with
registered read helpers, a sequential dispatcher and serialized direct child
envelopes. Replay interprets the frozen list without rerunning the callback.

`actions/service-registry.ts` now installs every declared syncable database kind
through its real `InTx` service, together with `system.compose`. The factory
requires complete host recovery registrations for local-only kinds and refuses
attempts to replace database handlers. Version 1 currently supports schemas 19–39.
Tests record and replay each database kind, check namespace ownership and apply
the executing host's limits. See the
[service registry](action-execution-scopes.md#dispatch-real-service-actions).

Registry recording and replay now require a matching live execution handle and
binding provider. Guarded ORM builders refuse implicit IDs and timestamps,
primary-key assignments, conflict clauses and insert-select. Runtime update
generators are also refused. Violations fail the root even when caught. These
checks are opt-in and leave ordinary transactions unchanged. Persistent SQL
guards and raw SQL allocation coverage remain pending.

The service registry also installs `system.repair` for explicit workspace-wide
inventory repair. Its envelope is `{args: {}, body: {target: "inventories"}}`.
It reuses the action transaction, preserves timestamps and allocates no IDs or
clocks. Replay may resolve a different repair set or no changes. Requested repair
remains separate from exact restoration. See
[repair requests](action-execution-scopes.md#request-an-inventory-repair).

Production application routing, system import, config and taskspace
observation envelopes remain pending. Contract version persistence and
group dispatch integration also remain pending. Do not submit work based only on
a declaration's sync classification.

Taskspace lifecycle and file methods are declared local-only while their current
handlers still combine filesystem work and shared rows. Before activation, split
lifecycle handlers into syncable shared changes and separate local operations.
Local-only handlers must then be prevented from changing shared rows.

Those declarations remain unchanged in contract version 1. The opt-in version 2
registry now routes taskspace lifecycle intents through shared database services
on schemas 20–39. Creation and label changes reject local path and observation fields.
The five file methods still require explicit host recovery registrations. Node
application lifecycle callers retain their existing filesystem workflows until
their routing is migrated. See the
[version 2 boundary](action-execution-scopes.md#replay-shared-taskspace-actions-with-version-2).

## Service and record writes

All paths below are relative to `packages/core/src`. Record methods exported from
`database.records` can also be called without services. Their mutation boundaries
must be covered before mandatory guards are enabled. Application modules in
`packages/kozane/src/db/api` and `packages/kozane/src/services` forward to core.

| Family | Service entry points | Record writes and indirect effects | Boundary work |
| --- | --- | --- | --- |
| Cards | `services/cards.ts` create, update, positions, remove, removeOne, move, layer, partition, stacking, squash | `api/card/{create,update,case-update,stacking,placement}.ts` and `api/composite/{cards,move,squash}.ts`. Includes glue cleanup, scope membership, inventory refits and split card creation | All listed service writes expose `InTx` variants, including stacking and squash. Production action attribution remains pending |
| Glues | `services/glues.ts` create, remove | `api/glue.ts` creates glue IDs, replaces memberships and dissolves orphan groups | Existing transaction and `InTx` helpers need current-action attribution |
| Layers | `services/layers.ts` create, rename, remove, reorder | `api/layer.ts`, `api/composite/reassign.ts`. Remove moves cards to the default layer | All listed service writes expose `InTx` variants. Removal reuses the caller's transaction for card reassignment. Action attribution remains pending |
| Partitions | `services/partitions.ts` create, rename, remove | `api/partition.ts`, `api/composite/reassign.ts`. Service removal moves cards to the default partition. The separate low-level cascading delete can delete cards | All listed service writes expose `InTx` variants. Attribute reassignment and raw cascading deletion |
| Scopes | `services/scopes.ts` create, rename, remove, addMembers, removeMembers, createArea, updateArea, removeArea, removeWorkspace | `api/{scope,scope-rel,scope-area}.ts`. Board removal differs from workspace deletion. Scope deletion can clear taskspace references and delete relations and areas | All listed service writes expose `InTx` variants, including board removal. Action attribution remains pending |
| Warps | `services/warps.ts` create, update, remove | `api/warp.ts` | Existing transaction and `InTx` helpers need attribution |
| Inventories | `services/inventories.ts` create, update, remove, stow, take, repair | `api/inventory/{rows,stow,slots,repair}.ts`. Moves other cards' slots, refits widths and clears placement on removal | The opt-in `system.repair` handler wraps requested inventory repair. Production CLI routing and action attribution remain pending |
| Namespaces | `services/namespaces.ts` create, rename, remove, setDefault; administration also calls records | `api/namespace.ts` add, create, rename, setDefault, delete. Creation adds default partition and layer. Deletion cascades and dissolves surviving orphan glue groups | All listed service writes expose `InTx` variants. Low-level add and rename still accept DB handles. Action attribution remains pending |
| Taskspaces | `services/taskspaces.ts` create, rename and remove for shared database operations; Node filesystem handlers described below | `api/taskspace.ts` add, update, delete. Shared identity and timestamps live in `taskspace`; paths and observations live in `taskspace_local`. Delete clears `card.taskspace_id` and retains local metadata | Shared services validate namespace visibility and use bound IDs and clocks. Host creation journals directory claims and confirms attachments atomically. Other filesystem journals and production action routing remain pending |

`services/snapshot.ts`, tags, map and warp-directory expose reads. Derived tag
indexes are rebuilt and are not stamped application tables.

## CLI, HTTP and filesystem paths

| Entry | Current behavior | Required action boundary |
| --- | --- | --- |
| HTTP routes in `packages/kozane/src/routes` | Dispatch to resource services or Node taskspace handlers | Capture route IDs before validation. Attribute the full service invocation |
| CLI card, glue, layer, inventory, scope and warp commands | Many use `composeWrite` to resolve short IDs and call `InTx` services. Some callbacks call low-level helpers | Resolve replayable references and serialize ordered dispatcher children, or replace callbacks with named handlers |
| CLI namespace commands | Create/default use services. Delete calls `deleteNamespaceInTx` inside `withImageDeletion` | Register namespace administration and preserve image history protection |
| CLI taskspace scan, prune and create in `cli/commands/taskspace.ts` | Scan updates local metadata. Reattachment inserts shared identity and updates retained metadata atomically. Prune deletes shared rows while retaining local metadata. Create also calls filesystem claim code | Attribute shared identity/placement separately from local observations and file recovery |
| CLI `taskspace attach` and `lib/server/taskspace-service/claim-existing.ts` | Attach a user-chosen directory to an existing namespaced shared identity. Journal intent before disk work, atomically confirm the local attachment and observation, and retain shared rows and interrupted evidence on failure. Existing claim recovery confirms matching completed work without creating files | Route shared creation separately when production action capture is activated |
| `lib/server/taskspace-service/label.ts` and the `/label` route | Rename a shared label and assemble the existing attachment reply in one transaction. Current clients use this route | Install production action attribution after capture activation |
| `lib/server/taskspace-service/{create,claim,recover-claim,recover-directory,mutate,directory-operation}.ts` | Create commits shared identity and pending local intent before claiming its directory. Managed deletion and legacy combined rename journal marker and directory identity before disk work, then commit shared changes, attachment updates and confirmation together. Startup and doctor inspect pending work. Recovery confirms verified claims or completed directory mutations without repeating disk work. Directory recovery can update shared labels or delete shared taskspaces and clear card links | Install production action attribution, including shared writes during directory recovery |
| CLI layout repair and `taskspace abandon` | Layout repair journals source, intermediate and destination paths, confirms local attachment updates atomically and leaves interrupted work pending. Explicit abandonment retains intent, error, reason and timestamp without changing files or shared rows | Journal other CLI filesystem writers and protect assets needed by history |
| `lib/server/taskspace-service/{file,files,file-operation,recover-file}.ts` and `taskspace-files.ts` | File create/save, directory create, entry rename/remove commit local intent before disk work and confirm afterward. Paths and intended content hashes survive interruption. Explicit recovery binds the recorded path to the current attachment and confirms reviewed outcomes without repeating callbacks. Shared rows and local attachments are unchanged | Install host recovery registrations at the action boundary and protect assets needed by history |
| `cli/lib/db-json/import.ts` | Validates dump, opens DB, deletes rows in reverse table order and inserts rows inside `withTx` | `system.import` must retain original input and bind missing timestamps. Exact restoration needs a separate path |
| `cli/commands/init.ts` | Creates config, migrates, then seeds a default namespace, partition and layer | Run migration/initialization before baseline activation, with restartable progress |
| `cli/commands/config.ts`, workspace config and config-editor handlers | Write config files | Local-only records and file recovery where needed |
| `lib/server/{image-assets,image-upload,image-upload-recovery}.ts`, image commands, upload route and card adapters | Reserve local upload names and byte metadata before disk publication. Verify installation and retain unfinished pins. Card create/update commit reference and pin completion together. Explicit recovery and abandonment change only local tracking under the same writer lock. Cleanup checks upload pins, registered manifest owners and references, including abandoned temporary files | Attach production action manifests and register history and transfer owners under their retention policies |
| `db/api/asset-manifest.ts` and `lib/server/image-manifest-retention.ts` | Reserve immutable manifests for local owners before byte verification. Verify live or archived bytes under the writer lock. Keep pending and retained owners pinned until explicit release, and preserve name identity after release | Wire production baseline, effect-set, transfer and recovery workflows to owner registration and release |
| `packages/core/src/migrations/apply.ts` and Node migration hooks | Driver-owned batch applies SQL and migration history | Trusted migrate mode and durable transition gate before capture activation |
| Database JSON export, DB backup/restore and standalone restoration harness | Export/read snapshots or replace database files | Keep exact recovery distinct from import, preserve local metadata and verify complete recovery bookkeeping |
| `lib/server/local-recovery-payload.ts` | Validate registered local snapshots, save canonical bytes under immutable hash-based filenames and inspect temporary or published evidence without retrying it. Read published bytes within an explicit host limit, validate SQL values in isolation and recheck file and catalog identity before returning. Preserve catalog intent and disk evidence after failures | Retain selected shared history, publish only complete bundles and integrate one-time installation and activation |
| `lib/server/shared-recovery-payload.ts` and `recovery-payload-files.ts` | Save registered shared row history with the local payload's synced exclusive file protocol in a separate directory. Inspect interrupted evidence, read only published bytes within a host limit and recheck both original catalog bindings and file identity after isolated validation | Retain complete action, execution and asset records, publish complete bundles and enforce durable installation and activation |
| `lib/server/recovery-asset-payload.ts` | Save canonical registered asset manifests through synced exclusive publication. Reopen bounded bytes, validate both saved sources and recompute manifest coverage. Optionally require saved execution and original contents with independent host limits. Check current inputs per set and first-recorded inputs against the combined manifest. Recheck all original catalog expectations and files while preserving interruption evidence after filesystem or commit failures | Retain complete action and execution records and publish complete bundles |
| `lib/server/shared-recovery-execution-payload.ts` | Save canonical registered execution payloads through synced exclusive publication. Reopen bounded bytes and validate both saved sources and execution attribution. Recheck all three original catalog bindings, source bytes and execution file identity. Preserve temporary and published evidence after filesystem or commit failures | Retain complete execution history and publish complete bundles before installation |
| `lib/server/shared-recovery-action-payload.ts` | Save canonical registered originals through synced exclusive publication. Reopen bounded bytes and validate all three saved sources, original inputs and bindings. Recheck all four original catalog bindings, source bytes and action file identity while preserving temporary and published evidence after failures | Retain complete history and publish complete bundles before installation |
| `lib/server/shared-recovery-action-archive-payload.ts` | Save registered archives through synced exclusive publication. Reopen bounded bytes, validate all four saved sources and preserve complete first-record inventories and exact current originals. Recheck all five original catalog bindings, source files and archive file identity while preserving interrupted evidence after filesystem or commit failures | Retain executions and effects for additional roots, protect their images and publish complete bundles |
| `lib/server/recovery-bundle-installation.ts` | Validate complete published bundles before local staging and before shared staging. Require the matching local installation before complete shared loading, or explicitly stage shared-only data in a new empty destination under its independently trusted receiving identity. Acknowledge exact destination records without reopening source files or replaying later edits | Install required history, bookkeeping and images before activation |
| `lib/server/recovery-file-operations.ts` | Capture exact pending evidence from matching complete local staging, perform bounded read-only disk observations and reread the page before returning. Refuse changed journal evidence and leave all operations pending | Keep confirmation, filesystem work and activation in their separate explicit boundaries |
| `lib/server/recovery-image-installation.ts` and `recovery-image-files.ts` | Check explicit staging identities, reload complete source bundles and commit destination manifest protection before file creation. Publish exact image bytes exclusively, verify finals and archives and retain protection under the image writer lock. Preserve failed publication evidence and reusable finals | Retain required history and bookkeeping before activation |
| `lib/server/staged-recovery-bundle.ts` | Retain eight canonical payloads before their index under verified destination image protection. Reopen without source catalogs or files, validate exact SQL states and recheck staging, files and image protection before success. Preserve interrupted publication evidence | Install production history and bookkeeping before activation |
| `lib/server/recovery-bundle.ts` | Validate all eight saved contents and exact original bindings, commit pending image protection before byte reads, and publish canonical indexes through synced exclusive files. Reopen bounded indexes only with retained protection, fresh source and physical byte checks and stable index identity. Preserve candidates, earlier pins and interrupted evidence after failures | Enroll complete capture and implement durable installation and activation |
| `lib/server/run-archive-asset-payload.ts` | Save registered broader run manifests through synced exclusive publication. Reopen bounded bytes and all seven saved sources, validate exact source SQL states, independent run endpoints and per-record image coverage, recheck all eight original catalog bindings and source files, and preserve manifest file identity and interrupted evidence | Publish complete bundles and implement durable installation |
| `lib/server/shared-recovery-run-archive-payload.ts` | Save registered broader runs through synced exclusive publication. Reopen bounded bytes, validate all five saved sources and every run's independent SQL endpoints, recheck all six original catalog bindings and source files, and preserve run file identity and interrupted evidence after failures | Publish complete bundles and implement durable installation |
| `lib/server/shared-recovery-retained-payload.ts` | Save registered retained runs through synced exclusive publication. Reopen bounded bytes and validate all four saved sources and both endpoints of each run in isolated SQL databases. Recheck all five original catalog bindings, source files and retained file identity while preserving interrupted evidence after publication or commit failures | Cover additional roots and publish complete bundles before installation |
| `lib/server/retained-recovery-asset-payload.ts` | Save registered retained manifests through synced exclusive publication. Reopen bounded bytes, validate all six saved sources and independent per-record coverage, and recheck all seven exact original catalog bindings and source files. Preserve manifest file identity and interrupted evidence after filesystem or commit failures | Cover additional roots and publish complete bundles before installation |
| `lib/server/local-recovery-images.ts` | Read a registered saved payload, check host history manifest IDs against its selection and reserve combined image requirements under a stable recovery owner. Commit pending protection before verifying live or archived bytes under the image writer lock. Preserve earlier protection after failed verification or commit | Obtain manifests from complete retained history, preserve the selected records and publish only complete bundles |
| `lib/server/recovery-checkpoint-images.ts` | Load registered saved manifests or check host manifests against both source payloads. Optionally verify saved execution, original, retained-run and broader run coverage. Carry all eight original catalog bindings and files through the image writer lock for broader manifests. Commit pending protection before reading image bytes and recheck every required binding and file around reservation and verification. Preserve earlier owners after changed requirements or failed reads, verification or commits | Retain complete action and execution records, publish complete bundles and implement durable installation |
| `packages/core/src/actions/local-recovery*.ts` | Capture all local rows and the host-read baseline and effect-set selection in one read transaction. Bind canonical snapshot contents to checkpoint descriptors after the read boundary closes. Collect active image requirements and check every immutable local identity against selected history manifests. Verify descriptors and identities before isolated SQL allocation, compare exact tagged read-back and remove temporary validation rows before success | Enroll durable identities and coordinate required destination history, assets and activation |
| `packages/core/src/actions/recovery-checkpoint-capture.ts` | Read complete selected shared history and all portable local rows through one consistent snapshot. Require canonical managed schema and complete migration history, derive matching selections, verify exact live shared rows and hash both owned payloads after read completion | Integrate durable production capture and retain required records and image protection through complete bundle publication |
| `packages/core/src/actions/shared-recovery.ts` | Reconstruct selected shared effect sets against a complete baseline in memory using separately trusted IDs, order and expected counts. Check full before images, refuse local tables and validate exact final rows in a separate empty database. Roll back temporary rows and mutating trigger removal before success, including cleanup and outer commit failure handling | Install required history and bookkeeping beside staged shared rows before activation |
| `packages/core/src/actions/shared-recovery-checkpoint.ts` | Canonicalize shared row-history payloads and bind checkpoint identities, selected IDs, counts, the complete baseline and intermediate effects to content descriptors. Verify separately retained expectations before isolated SQL validation, without storing descriptors or history | Persist trusted descriptor bindings, retain complete action and execution records with assets, and publish complete bundles before installation |
| `packages/core/src/actions/shared-recovery-store.ts` | Persist an immutable shared descriptor and its original local snapshot descriptor under one checkpoint key. Check matching identity and selected IDs under the writer lock. Resolve trusted expectations and recheck both live bindings after hash and SQL validation without converting registration timestamps | Retain history files and required assets, publish complete bundles and enforce durable installation and activation |
| `packages/core/src/actions/shared-recovery-assets.ts` | Parse immutable shared-history manifest metadata, require exact selected IDs and check baseline and full effect image coverage. Preserve extra host requirements and refuse conflicting immutable image identities | Obtain trusted manifests from complete invocation and execution records and verify physical bytes through the host |
| `packages/core/src/actions/recovery-asset-checkpoint.ts` | Bind per-record history manifests and combined image requirements to both original checkpoint descriptors. Copy inputs before hashing, verify independently retained asset expectations and both source hashes, and require exact row and local coverage | Retain complete records and enforce complete bundle publication |
| `packages/core/src/actions/retained-recovery-asset-checkpoint.ts` | Bind per-run retained manifests and original-input requirements to the exact retained-history binding and current asset descriptor. Verify all six source contents, independent row and invocation coverage and the exact union with current local requirements and host extras. Own metadata before hashing and preserve historical descriptors as metadata | Cover additional roots and publish complete bundles |
| `packages/core/src/actions/retained-recovery-asset-store.ts` | Register immutable retained-manifest expectations after checking all six original source catalogs. Own inputs before catalog reads and recheck all seven original expectations after content verification. Preserve exact historical and orphaned metadata through shared replacement, local validation and version 26 JSON exports | Cover additional roots and publish complete bundles |
| `packages/core/src/actions/recovery-asset-store.ts` | Persist trusted asset expectations under immutable checkpoint keys. Require both original live source bindings before registration, recheck all three catalogs after content verification and retain historical or orphaned metadata without timestamp conversion | Enforce complete bundle publication and installation |
| `packages/core/src/actions/shared-recovery-executions.ts` | Prepare selected scope records with independently trusted roots and execution counts. Check frame bindings, no-op children, sequential trees and complete effect attribution. Bind canonical contents to the original shared descriptor and check invocation image requirements without dispatching handlers | Retain complete execution history and enforce complete bundle publication |
| `packages/core/src/actions/shared-recovery-execution-store.ts` | Register immutable execution expectations with their original local descriptor binding. Require both live source catalogs, resolve expectations before hashing and recheck all three catalogs before success. Preserve historical and orphaned metadata without timestamp conversion | Retain complete execution history and enforce complete bundle publication and installation |
| `packages/core/src/actions/shared-recovery-actions.ts` | Prepare original action records with trusted IDs, exact first-record sequence strings and provenance. Bind original inputs and allocations to the selected execution descriptor, require immutable root data and preserve changed or skipped child inputs separately. Check original invocation image requirements without running handlers | Persist complete retained history and enforce complete bundle publication |
| `packages/core/src/actions/shared-recovery-action-archive.ts` | Prepare original records for additional roots under a separately trusted root and action inventory. Require exact current originals and first-record parent and binding relations, verify the current source hashes and collect archived-input images while owning inputs before hashing | Retain additional executions and effects and connect complete image requirements before bundle publication |
| `packages/core/src/actions/shared-recovery-action-archive-store.ts` | Register immutable archive expectations with exact original local bindings after checking all four source catalogs. Own inputs before reads and recheck all five original expectations after hashing. Preserve historical and orphaned metadata through shared replacement, local validation and version 26 JSON exports | Retain additional executions and effects and protect complete image requirements |
| `packages/core/src/actions/shared-recovery-run-archive.ts` | Prepare origin, rebase and authoritative runs for broader archived roots under an independently trusted inventory. Verify all four source payloads, original identities and nested run hashes, preserve selected materialization, validate every SQL endpoint and collect per-run image requirements | Publish complete bundles and implement durable installation |
| `packages/core/src/actions/shared-recovery-run-archive-store.ts` | Register immutable run-archive expectations with exact original local bindings after checking all five source catalogs. Own inputs before reads and recheck all six original expectations after hashing. Preserve historical and orphaned metadata through shared replacement, local validation and version 26 JSON exports | Publish complete bundles and implement durable installation |
| `packages/core/src/actions/local-recovery-installation.ts` | Validate identity, local content, canonical destination schema and complete migration history. Install exact local rows and a singleton immutable destination record atomically. Keep authority outside snapshots, shared projections and JSON, preserve later edits on retry and refuse conflicting or populated destinations | Coordinate complete destination staging and activation |
| `packages/core/src/actions/recovery-file-operations.ts` | Read exact tagged pending rows and decimal-string counts under one snapshot after checking canonical schema, complete migration history and matching local authority. Preserve opaque intent, errors and unsafe timestamps | Keep observation separate from confirmation and activation |
| `packages/core/src/actions/shared-recovery-installation.ts` | Require matching local authority, complete migration history and empty shared tables. Validate and atomically stage exact shared rows with an immutable record. Preserve current local metadata, restore business triggers and acknowledge matching retries | Install required history, bookkeeping and images before activation |
| `packages/core/src/actions/shared-only-recovery-installation.ts` | Verify independent source and receiving identities, canonical schema and complete migration history. Atomically stage exact shared rows and immutable receiving authority in an empty destination without source local metadata. Preserve later receiving-device edits and refuse mode changes | Install required history, bookkeeping and images before activation |
| `packages/core/src/actions/recovery-bundle-index.ts` | Bind all eight original payload references and complete image requirements into one canonical index and content descriptor. Verify every source and independent coverage, own inputs before hashing and preserve historical metadata without authorizing publication | Publish complete bundles and implement durable installation |
| `packages/core/src/actions/run-archive-asset-store.ts` | Register immutable broader run-manifest expectations after checking all seven original source catalogs. Own inputs before reads and recheck all eight expectations after verification. Preserve historical and orphaned metadata through shared replacement, exact local validation and version 26 JSON exports | Publish complete bundles and implement durable installation |
| `packages/core/src/actions/run-archive-asset-checkpoint.ts` | Bind per-run and broader original-input manifests to the exact run archive binding and current asset descriptor. Verify all seven source contents, independent row and actual invocation coverage, never-executed inputs and the exact combined requirements including local images and host extras | Publish complete bundles and implement durable installation |
| `packages/core/src/actions/shared-recovery-retained-history.ts` | Prepare retained origin, superseded rebase and authoritative runs for selected roots with independent inventory and complete per-run contexts. Check original and selected source bindings, reconstruct deselected runs separately, validate before and after SQL projections in isolated databases and collect per-run row and invocation image requirements | Persist retained manifests, protect their images, cover additional roots and publish complete bundles |
| `packages/core/src/actions/shared-recovery-retained-store.ts` | Register immutable retained-history expectations with the exact original local descriptor and all nested source bindings. Require all four live source catalogs and recheck all five original expectations after content verification. Preserve exact historical and orphaned metadata through shared replacement, local validation and version 26 JSON exports | Retain manifests, cover additional roots and publish complete bundles |
| `packages/core/src/actions/shared-recovery-action-store.ts` | Register immutable original-action expectations with the exact original local descriptor. Require matching execution, shared and local catalogs before registration and recheck all four expectations after content verification. Preserve coherent historical and orphaned metadata without timestamp conversion | Enforce complete history retention and bundle publication |

The `cli/lib/db-json/import.ts` helper does not call inventory repair. The CLI
command in `cli/commands/db.ts` performs a separate post-import repair after the
import commits. That call still needs a persistent `system.repair` action when
the import command is migrated. Preserve this distinction when implementing
the import contract. Likewise, service partition removal
currently reassigns cards rather than deleting them. Test cascading deletes
through the low-level path separately.

## Allocations, clocks and conflict modes

| Location | Existing source | Replacement before stamping |
| --- | --- | --- |
| `schema.ts` | UUIDv7 `$defaultFn` for namespace, partition, layer, scope, scope_area, warp, inventory, taskspace, card and glue | Supply IDs explicitly through stable action binding paths |
| `schema.ts` | `new Date()` defaults for taskspace and card timestamps | Explicit bound clock readings before SQL execution |
| `api/card/create.ts` `newCardStamps` | One `new Date()` for creation timestamps, shared by batch inserts | Bind creation time at the handler's stable invocation path |
| `api/card/update.ts` | `Math.floor(Date.now() / 1000)` used in conditional text update SQL | Bind the clock before the update, preserve unchanged-text behavior |
| `api/taskspace.ts` | Ordinary timestamp defaults and `Date.now()` on label requests | Guarded creation binds one timestamp for both columns. Label requests bind their conditional update clock. Location updates preserve shared timestamps |
| CLI taskspace scan/create | `Date.now()` and `new Date()` | Local observation records and bindings where replay/recovery needs them |
| `drizzle/0011_card_timestamps.sql` | Migration-time `unixepoch()` backfill | Allowed only during migration before baseline capture |
| `drizzle/0005_layer.sql` | SQL random UUID backfill | Allowed only during migration before baseline capture |
| `drizzle/0019_card_guards.sql` | `card_stamp_missing_timestamps` calls `unixepoch()` after insert | Replace with record-mode validation in a new migration. Bind import defaults and bypass validation in trusted restore mode |
| `api/scope-rel.ts` | Membership creation | Existence checks now run in the same write transaction as ordinary inserts. Duplicate inputs are deduplicated before batching |
| `api/composite/squash.ts` | Inherited scope relations for newly created cards | Ordinary inserts now run inside the squash transaction. Newly created card IDs cannot already have memberships |
| Image upload in `lib/server/image-assets.ts` | `randomUUID()` for filenames | Durable staging name reservation outside the DB data transaction |

The core lint rules now prohibit `onConflictDoNothing`. Membership idempotency
uses existence checks, and tests verify that duplicate requests never reach
`BEFORE INSERT` capture. A failure in a later batch rolls back earlier inserts
and their captured attempts.

The inspected runtime core writes contain no `INSERT OR IGNORE` or
`RAISE(IGNORE)`. Migration copies and generated SQL remain a separate audit
surface. The `strftime(..., 'unixepoch')` in card reads converts stored dates
and does not read the wall clock. Export timestamps and cleanup timers are not
application-row timestamps.

`actions/bindings.ts` now supplies entity IDs, child IDs and integer clock values
from injected sources during recording. Replay copies the recorded map, permits
skipped bindings and refuses unbound paths or type changes. Snapshots preserve
unused bindings. Path keys encode tuples so separators in entity IDs cannot
collide. The execution scope adds hierarchical child paths and handler-scoped
allocation paths. Replay preserves the original map while recording the actual
child envelopes and entry order for that run. `actions/allocations.ts` now binds
generated IDs in the namespace, partition, layer, scope, scope-area, warp,
inventory, glue, card and taskspace record helpers when called through a guarded action
handle. Single and batch card creation bind timestamps before insertion. Card
text updates bind their SQL clock while retaining the unchanged-text comparison.
Batch IDs use original input indexes before SQL chunking. Other IDs use table
roles within the owning handler's stable invocation path. See
[allocation keys](action-execution-scopes.md#invocations-and-allocations).

Squash now reuses its caller's transaction. Its inventory, piece IDs and shared
creation timestamp bind to the source card ID and segment roles. Replaying fewer
segments preserves unused bindings. Requiring an extra segment or a different
source refuses replay without extending the map. Layout and inventory naming
still resolve against the current rows.

Taskspace creation and label clocks are also bound. Database creation and label
APIs exclude local observation fields. Location updates and CLI scans preserve
shared timestamps. The record methods share the root failure latch, including
caught validation errors. Local metadata now has independent storage without
cascading deletion and is excluded from shared capture. Version 1 taskspace
lifecycle kinds remain local-only. Version 2 adds the shared service handlers,
and application filesystem workflows still need separate routing.

Ordinary handles retain their creation defaults. Production application routing
and raw SQL allocation coverage remain pending. The
migration 0019 timestamp fallback remains unchanged and must be replaced before activation.
`actions/import-timestamps.ts` resolves missing or zero creation
timestamps through a binding keyed by the imported card ID. A missing or zero
update timestamp follows creation time. Supplied nonzero timestamps and the
original input remain unchanged. The resolver is not yet connected to CLI import
and must never be used for exact restoration. Use epoch seconds when binding
SQLite timestamps. Do not use query result positions to identify allocations.

## Tables, triggers and adapter gate

Application tables are `namespace`, `scope`, `scope_area`, `partition`, `layer`,
`warp`, `inventory`, `taskspace`, `card`, `glue`, `glue_rel` and `scope_rel`.
All have a single `id` primary key except `glue_rel`, whose key is `card_id`,
and `scope_rel`, whose complete key is `(scope_id, card_id)`.

Migration 0019 adds two validating `BEFORE` triggers for inventory placement.
Its mutating triggers run `AFTER` and clear inventory slots or fill timestamps.
Capture must observe the slot-clearing update and all foreign-key cascade/set-null
writes. Replace the timestamp fallback before activation. Gate mutating triggers
out of trusted restore mode without disabling write guards.

The Node/libsql setup, WASM parity adapter and browser restoration worker now use
`configureActionConnection` to enable and verify `foreign_keys` and
`recursive_triggers`. Each opt-in action transaction repeats configuration before
entering handlers and verifies both flags after its completion hook. This covers
recycled libsql connections. Disabled foreign keys refuse entry because SQLite
cannot enable them inside an open transaction. Libsql and Node WASM regression
tests pass. Browser runtime verification remains pending.

The [capture prototype](action-capture-prototype.md) passes persistent `BEFORE`
capture, projection reconstruction and lossless installation checks on libsql and
Node WASM. Browser verification remains pending because Chromium was unavailable
and its download was denied by the environment's network policy. Keep production
log tables and activation gated on that verification. Existing JSON export values
cannot serve as the row codec.

The [fixed capture commands](action-capture-prototype.md#run-the-checks) verify
the required suite inventory and refuse focused, skipped or missing checks.
Workspace verification includes the WASM gate. CI runs the browser gate after
Chromium installation. Browser runtime verification remains pending until that
command completes on the tested revision.

The [epoch transition prototype](prototype-epoch-transitions.md) adds persistent
write blocking, ordered migration batches and candidate baseline activation to
the test fixture. Native restart tests cover committed repair and baseline
interruption. Production epoch storage and migration integration remain pending.
The fixture reserves pending baseline image owners before verification, retains
them with candidate publication and checks exact retained protection at activation.
Native file tests cover cleanup, restart and competing owner release while
earlier history owners remain protected.

The [initialization prototype](prototype-capture-initialization.md) installs
capture guards, pending image protection and a blocking transition in one commit.
It validates an initial candidate separately and completes activation and staging
pin release atomically. Production initialization and migration policy remain
pending.

## Tagged row codec

`actions/row-codec.ts` implements encoding version 1 for SQL NULL, signed 64-bit
INTEGER, finite REAL, Unicode TEXT and BLOB values. INTEGER encoding accepts
`bigint` and decoding returns `bigint`. REAL encoding preserves the full binary64
bit pattern, including signed zero. TEXT preserves embedded NUL and is not
normalized. Unpaired surrogates are rejected. BLOB encoding uses lowercase hexadecimal bytes.

Row comparison includes every column, storage class and REAL bit pattern while
ignoring object property order. Projection key encoding sorts primary-key column
names. Malformed tags, noncanonical values, unknown encoding versions and accessors
are rejected. Rows and tagged values are copied and frozen.

Unit tests cover JSON transport, both signed 64-bit limits, integers beyond the
JavaScript safe range, subnormal REAL values, Unicode, embedded NUL and empty blobs.
The codec requires actual SQLite storage classes and uncoerced values from the
adapter. The capture prototype supplies SQL encoding and installation expressions
and verifies full read-back equality on libsql and Node WASM. Browser support and
production integration still need verification.
