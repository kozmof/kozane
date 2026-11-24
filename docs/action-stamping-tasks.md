# Action stamping and sync tasks

Implement durable action stamping and restoration first, then add sync. This is
the canonical progress list. Implemented contracts and checks are documented in
the [write inventory](action-stamping-write-inventory.md),
[capture prototype](action-capture-prototype.md),
[execution scopes](action-execution-scopes.md) and
[composition API](action-composition.md).

Phases 1–3 are in progress. See the [write inventory](action-stamping-write-inventory.md).
Version 1 client envelopes and sync classifications have compile-time coverage.
Versioned registry selection, complete routing checks, replay-safe allocation
bindings, import timestamp resolution and the tagged row codec are implemented
and unit-tested. Production application routing, system envelopes, persistence
and write-path integration remain pending. The persistent capture, unconstrained
projection and lossless installation prototype passes on libsql and Node WASM.
Browser verification remains pending because Chromium was unavailable and the
environment denied its download. Skipped-insert upserts have been removed. Direct
layer, partition and scope service writes now use adapter transactions and expose
transaction-bound variants. An opt-in execution scope now provides handler-entry
ordering, scoped bindings, ownership checks and a failure latch shared by core
transaction-bound services. Caught child, SQL and pre-SQL service failures abort
the root after outstanding work settles. Production action attribution and
application routing remain pending. The opt-in
`system.compose` implementation now records direct child envelopes and IDs,
provides registered readers and sequential dispatch, and replays without the
recording callback. Existing `composeWrite` callers still need migration. Capture
guards remain disabled.

Connection setup now enables and verifies foreign keys and recursive triggers in
the Node host, WASM parity adapter and restoration worker. Opt-in action scopes
repeat setup before handlers and verify again after completion. Libsql and Node
WASM tests cover recycled connections, entry refusal and rollback when settings
change. Browser runtime verification remains pending.

Opt-in replay transactions now isolate each root with a savepoint and a fresh
execution scope. Compositions can use the same session. Failed roots roll back
before later roots enter. Savepoint boundary failures, overlapping calls and
unfinished roots abort the outer transaction even when caught. Production
reconciliation, outcome handling and failure classification remain pending.

Guarded action handles now bind generated IDs in the namespace, partition, layer,
scope, scope-area, warp, inventory, glue and card record helpers. Single and batch
card creation bind their shared timestamps. Text updates bind clocks while
preserving unchanged-text timestamps. Taskspace record creation and label edits
also bind IDs and clocks. Raw SQL allocations and production action routing still
need integration before activation.

Stacking, squash, layer and partition removal, board scope removal and namespace
administration now reuse caller-owned transactions through `InTx` variants. Their
service failures share the active root latch. Squash binds inventory and piece
IDs and timestamps to the source card and segment roles. Production stamping
remains pending.

The opt-in service registry now installs real handlers for every declared
syncable database kind and `system.compose`. It supports schemas 19–37 and requires
explicit host recovery registrations for local-only kinds. Application routing,
system import handlers, durable recovery and persistence remain
pending.

`system.repair` now accepts the explicit `inventories` target and runs the real
workspace-wide repair service in its action transaction. Replay can resolve
changed rows or a no-op while preserving the original request and timestamps.
CLI repair routing, including the separate post-import repair, remains pending.

The real service registry now requires its owning live action handle and binding
provider. Guarded ORM writes refuse implicit generated values, primary-key
assignments, conflict clauses, insert-select and runtime update generators.
Captured timestamps are copied before query construction. Persistent SQL guards
and raw SQL allocation coverage remain pending.

A test-only fixture now connects persistent capture on all 12 shared application tables
to real service actions and execution hooks. It verifies group-wide effect order,
parent and child attribution, no-op executions, finalized compositions, cascades
and exact reconstruction across successive groups. Failed commits, replay roots
and capture validation roll back application rows and history together. Local
libsql commits use the driver's exec path to avoid a retained lock after deferred
constraint failures. Production capture tables and activation remain gated on
browser verification and the remaining write coverage.

An internal restoration planner now derives an acyclic load order and refuses
omitted parents or excluded tables that reference restored rows. A test-only
validator loads complete application projections into isolated databases with
mutating triggers suppressed. Constraints, the inventory pair invariant, foreign
keys and exact codec read-back are checked on libsql and Node WASM. Production
epoch validation and installation remain pending.

The capture fixture now has a test-only restore mode and persisted materialization
selection. It validates selected history in an isolated database, atomically
replaces populated rows and selection, and preserves all origin history. Guards
stay installed while capture and mutating triggers are suppressed. Libsql and
Node WASM tests cover continued recording, failed validation, partial installation
and read-back rollback. Production restoration still requires epoch and local
metadata integration.

Taskspace records now expose transaction-bound database creation, label edits,
location updates and deletion. Label edits preserve local observations, and
location updates preserve both shared timestamps. CLI scans use the location
API. Creation and label clocks use scoped bindings, and caught record failures
abort their root. Migration 0020 now moves paths and observations to
`taskspace_local` without a foreign key to shared rows. Readers join metadata
only for present taskspaces, while local recovery readers retain absent rows.
Shared capture, validation and replacement exclude that table. JSON version 26
exports local rows separately, including absent taskspaces, and retains local file
operations. Imports of versions
7 through 9 split their inline values without changing the original dump.
Application lifecycle callers still use the version 1 local-only handlers.

The retained taskspace, upload, manifest and checkpoint cohorts cover migrations
20–37, through `0037_local_recovery_installation`. Twenty-three cohorts retain
eighty-six databases. Packed core and client checks pass eleven current-schema
view outcomes and 215 earlier-schema envelope outcomes. The migration-37 producer
pins source revision `4606322`. All older cohorts remain unchanged. Browser execution of
these cohorts remains pending.

Contract version 2 now registers database-only taskspace creation, label changes
and removal on schemas 20–37. These shared services reject local metadata inputs,
validate namespace visibility and return shared fields only. Version 1 retains
its local-only lifecycle meanings. Version 2 compositions can record and replay
shared taskspace children while the five file methods remain local-only.
Application lifecycle routing and durable filesystem recovery remain pending.

The board's taskspace rename now uses a dedicated label endpoint backed by the
shared service. It preserves directory paths, marker bytes and local observation
timestamps, including while an editor file remains open. Response assembly shares
the label transaction. The old combined endpoint retains its directory behavior
for earlier clients. Creation, removal, durable local recovery and production
action persistence still need application integration.

Migration 0021 now journals taskspace directory claims before disk work. Creation
publishes the local attachment and confirmation together, preserves pending
evidence after interruption and reports it through `doctor` without retrying
callbacks. Shared restoration preserves the journal, and JSON exports include
records for absent shared identities. Startup now reports pending claims without
changing them. `taskspace recover` previews and explicitly confirms a verified
attachment without retrying filesystem work. Migration 0022 now journals the five file
mutations, retaining affected paths and intended content hashes before disk work.
`doctor` and startup inspect pending file work without retrying callbacks. File
mutations leave shared rows unchanged, and shared restoration preserves their
local evidence. Migration 0023 journals managed-directory deletion and legacy
combined rename. Their shared changes, attachment updates and journal
confirmation commit together. Completed disk changes and pending evidence survive
a failed final transaction. CLI layout journals now include temporary paths and
leave interrupted work for inspection. Migration 0024 retains explicit abandonment
decisions, including their reasons and timestamps, without changing files or shared
rows. Explicit recovery now confirms completed directory moves, layout changes and
removals after verifying the original taskspace snapshot and disk evidence. It commits
database changes and confirmation together without repeating filesystem work.
File recovery now explicitly confirms matching outcomes for all five file methods
after binding the requested path to the current attachment. Confirmation changes
only tracking and never repeats filesystem callbacks. Recorded filesystem errors
still require manual review. See
[local filesystem operation records](local-file-operations.md).

Internal image-manifest builders now collect requirements from tagged baselines,
original invocations and full before and after images. They verify required byte
lengths and hashes and reject conflicting bytes under one name. Native and WASM
capture tests cover intermediate and deleted images. The capture prototype now
persists baseline rows and manifests, attaches manifests atomically to completed
effect sets, and verifies selected bytes before restoration. It refuses history
changes during asset preparation. Production manifest attachment and protection
for retained history remain pending. See
[image manifests for retained action data](action-asset-manifests.md).

Migration 0025 now reserves local image upload names and byte metadata before disk
publication. Installation verifies synced bytes and retains interrupted evidence.
Application card create and update commit staging completion with the reference.
Cleanup checks live references and unfinished pins under the same writer lock.
JSON version 15 retains upload records without installing files. Image commands
now preview and explicitly recover verified installation or abandon a reviewed
pin while preserving evidence. Startup and doctor inspect unfinished records
without retrying work. Production history manifests and transfer pins remain
pending. See [local image upload staging](image-upload-staging.md).

Migration 0026 adds a durable local manifest ledger. Pending and retained owners
protect registered baseline, effect-set, pending-work, transfer and recovery images
from cleanup. The host verifies live or archived bytes under the image writer lock
before publication and preserves reservations after failed commits. Explicit
release leaves other owners and live references protected. JSON version 16 retains
owner records and release decisions. Production workflow registration remains
pending. See [local manifest retention](asset-manifest-retention.md).

The capture prototype now publishes local baseline and effect-set ownership in
the same transaction as captured history. Node integration tests verify actual
files before transferring staging protection. Intermediate, deleted and
invocation-only images survive cleanup, including after history is deselected.
Upload completion rolls back with failed history publication. Native and WASM
tests verify atomic owner publication and staging preservation after publication
and commit failures. This remains a prototype integration rather than production
action routing.

An internal local recovery snapshot now captures all fourteen portable local tables and the
shared baseline and effect-set selection in one adapter read transaction. It
preserves tagged SQLite values and absent taskspace metadata, requires complete
table coverage and checks workspace, device, epoch, checkpoint and schema identity.
Native and WASM tests cover exact values and malformed input. A native concurrent
writer test verifies checkpoint consistency. Durable identity enrollment remains
pending. Bundle publication and local staging use the host workflows described below. See
[local recovery snapshots](local-recovery-snapshots.md).

Local snapshots now have an isolated SQL validation boundary. It rejects identity
mismatches before database allocation, refuses populated or incompatible
validation databases and compares loaded rows with the exact tagged snapshot.
Temporary rows are removed before success. Native and WASM tests cover SQL
constraints, affinity changes, changed read-back and connection flags, savepoint
cleanup failures and failed commits. One-time local staging now uses this boundary
through the host workflow described below. Workspace activation remains pending.

Local snapshot asset checks now collect pending and installed uploads and every
active manifest owner. They merge selected shared-history manifests while
checking all immutable name identities, including inactive records. Malformed
metadata and collisions refuse validation before database allocation. Node tests
verify recovery-owner protection through cleanup and byte verification, including
missing required files. Complete bundle publication and history retention remain
pending.

Local checkpoints now have versioned content descriptors with canonical UTF-8 byte
lengths and SHA-256 hashes. Capture closes its read transaction before hashing.
Descriptor verification checks identity, history selection and exact snapshot
contents before isolated SQL validation allocates a database. Native and WASM
tests cover canonical ordering, exact TEXT cells, payload changes and caller
mutation while hashing. Installation receipts remain pending.

Migration 0027 adds a durable local descriptor catalog. Registration is idempotent
for the same contents and refuses reuse of an identity with another descriptor.
The catalog survives shared restoration and is included in local snapshots and
version 26 JSON exports. Historical descriptors remain readable as metadata
without authorizing old-schema snapshot loading. Registration does not store
payload bytes, retain history or pin images. Bundle publication and one-time
installation remain pending.

Catalog-backed validation now resolves expectations from trusted local records
rather than received snapshot data. It verifies the saved descriptor before SQL
allocation and rechecks the binding after isolated validation. Missing records,
changed contents and bindings removed or replaced during preparation refuse
success. Unrelated registrations remain allowed. Installation and activation
still require their own durable boundary.

Registered local snapshot payloads can now be saved as immutable hash-named files.
The host validates the trusted catalog and SQL snapshot before disk work, writes
and syncs temporary bytes, publishes exclusively and preserves evidence after
filesystem or commit failures. Inspection is read-only and temporary data is not
retried automatically. A public `@kozane/core/recovery` entry exposes the trusted
preparation helpers. Complete bundle publication, history retention and
destination activation remain pending. See
[saved local snapshot payloads](local-recovery-payloads.md).

The host can now read published payloads with an explicit byte limit and trusted
identity. It verifies canonical bytes and exact SQL values, refuses temporary
evidence, and checks the file and catalog again after isolated validation.
Preparation leaves saved files unchanged and installs no local rows. One-time
installation and complete bundle retention remain pending.

Registered saved checkpoints can now reserve and verify image requirements under
a stable recovery owner. The host supplies manifests from complete retained
history, and the workflow checks their IDs against the checkpoint selection.
Pending protection commits before file verification and survives missing bytes
or failed verification commits. Cleanup and competing owner releases share its
writer lock. Retaining history records and publishing complete bundles remain
pending.

A public shared projection validator now checks complete reconstructed rows in
an isolated empty database. It preserves exact tagged values under canonical
constraints, rolls back temporary rows and business-trigger changes before
returning, and refuses cleanup or commit failures. Native and Node WASM checks
cover the preparation boundary. Complete history retention, installation and
activation remain pending. See
[shared recovery projections](shared-recovery-projections.md).

Shared reconstruction now applies selected effect sets against a complete
baseline in memory. A separate trusted selection supplies IDs, order and expected
effect counts. Missing, duplicate or unselected records, truncation, ordinal gaps
and mismatched full before images refuse a result. Native and Node WASM tests
cover real captured cascades without changing local paths or retained origin
history. Complete history retention remains pending.

Shared row history now has a canonical payload and content descriptor bound to
the originating checkpoint identity, selected IDs and expected counts. Hashes
cover the baseline and every intermediate effect, even when different histories
produce the same final projection. Verification checks separately retained
expectations before allocating isolated SQL validation. Complete action and
execution retention and bundle publication remain pending.

Migration 0028 now persists trusted shared-history descriptors together with the
original registered local snapshot expectation. Registration checks identity and
selected IDs, is idempotent for the same pair and refuses replacement. Both
catalog bindings are rechecked after shared hash and SQL validation. Local
snapshots and version 26 JSON exports preserve this sixth local table. Complete
history retention, bundle publication and installation remain pending.

Registered shared row-history payloads can now be saved and reopened through the
Node host. Local and shared files use the same synced, exclusive publication
protocol in separate directories. Shared operations check the original pair of
catalog expectations, preserve interrupted evidence and refuse changed files or
bindings. Reads require an explicit byte limit and isolated SQL validation.
Complete action and execution retention, bundle publication and installation
remain pending. See [saved shared payloads](shared-recovery-payloads.md).

Saved local and shared payloads can now reserve and verify their combined image
requirements. Core checks each manifest against the baseline and full effect
images, including intermediate and deleted references, and preserves extra host
requirements from complete invocations. The Node workflow rechecks both payload
files and catalog bindings under the image writer lock. Pending protection
commits before image reads and survives failed verification or commits. Complete
action and execution retention and bundle publication remain pending. See
[saved checkpoint images](recovery-checkpoint-images.md).

Core now describes canonical asset payloads bound to both original checkpoint
descriptors. The content hash covers per-record manifest associations, including
invocation-only requirements, and the combined image requirements. Verification
checks both source payload hashes and recomputes exact coverage. The Node host
can now retain these payloads through the trusted catalog workflow. See
[recovery asset checkpoints](recovery-asset-checkpoints.md).

Migration 0029 now retains trusted asset descriptors under immutable checkpoint
keys. Registration requires both original source bindings, and catalog-backed
verification rechecks all three records after hashing. Shared restoration keeps
the new local catalog, and local validation checks nested expectations before
SQL allocation. JSON version 26 preserves current and historical metadata.
Native and Node WASM tests cover rollback and changed bindings. Native tests also
cover competing registrations across connections. Complete action and execution
retention and complete bundle publication remain pending.

Registered asset manifests can now be saved and reopened through the Node host.
The workflow validates both saved source payloads with independent byte limits,
checks canonical manifest contents and rechecks all three catalog bindings under
the writer lock. Synced exclusive publication preserves interrupted evidence.
Reads refuse changed files and temporary entries without installing rows or
images. Complete action and execution retention and complete bundle publication remain
pending. See [saved asset manifests](recovery-asset-payloads.md).

The image workflow now accepts `assetMaxBytes` to load registered saved manifests.
It carries all three original bindings and files through the image writer lock,
commits pending protection before image reads and preserves earlier owners after
failed loading, verification or commits. Exact earlier host reservations remain
reusable, while changed requirements refuse replacement. Native tests cover
cleanup, archived invocation-only bytes, retained retries and competing writes.
Complete action and execution retention and bundle publication remain pending.
See [saved manifest image protection](recovery-checkpoint-images.md#use-registered-saved-manifests).

Core can now prepare selected scope records alongside shared row history.
Separately trusted root IDs and execution counts preserve no-op children. The
validator checks frame bindings, sequential parent and effect attribution, and
canonical content hashes bound to the original shared descriptor. Invocation
image checks include zero-effect sets. Native and Node WASM tests include real
captured scopes. Original action retention and complete bundle publication
remain pending. See [shared recovery executions](shared-recovery-executions.md).

Migration 0030 now retains trusted execution descriptors and their original local
bindings. Registration requires both live source catalogs and refuses identity
reuse with changed contents. Catalog-backed verification rechecks all three
records after hashing. Exact local snapshots and JSON version 26 preserve
historical and orphaned metadata. Native and Node WASM tests cover rollback and
changed bindings, and native tests cover competing registrations.

The Node host now saves and reopens registered execution payloads through synced
exclusive publication. Independent limits bound execution, shared and local
payload reads. Both saved sources undergo exact SQL validation before execution
attribution is checked. All three original catalog bindings and source bytes
are rechecked around file work. Native tests cover changed files, unsafe paths,
interrupted publication, competing writers and failed commits. See
[saved execution payloads](shared-recovery-execution-payloads.md).

Saved asset save/load and checkpoint image protection now accept an explicit
`executionMaxBytes` limit. They check each set's manifest against trusted saved
root and child inputs, including no-op children and zero-effect roots. All four
original catalog bindings and files remain checked through publication,
reservation and verification. Native tests cover unchanged combined manifests,
changed execution evidence, archived invocation images, cleanup handoff,
competing writers and failed commits. Complete execution history and complete
bundle publication remain pending. See
[saved execution image coverage](recovery-checkpoint-images.md#check-saved-execution-images).

Core can now prepare original action records beside selected executions. An
independently trusted ID selection preserves first-recorded invocations,
bindings, exact SQLite sequence strings and provenance. Verification requires
matching root inputs and full provider maps while allowing later child inputs
and used binding subsets to differ. Skipped original children remain retained
and their image requirements can be checked separately. See
[original recovery actions](shared-recovery-actions.md).

Migration 0031 now retains trusted original-action descriptors with exact
original local bindings. Registration requires the execution, shared and local
catalogs, and catalog-backed verification rechecks all four expectations after
hashing. Local snapshots and JSON version 26 preserve historical and orphaned
metadata without timestamp conversion. Native and Node WASM tests cover changed
bindings, shared replacement, local validation and migration rollback. Native
tests cover competing registrations and JSON import rollback.

The Node host now saves and reopens registered original-action payloads through
synced exclusive publication. Independent limits bound original, execution,
shared and local payload reads. The saved sources undergo content, attribution
and exact SQL validation. All four original catalog bindings and source files
remain checked around file work. Native tests preserve first-recorded and
skipped child inputs, exact sequence strings and provenance through reopening.
They also cover unsafe paths, large inputs, changed files, competing writers
and failed publication or commits. Complete history retention and bundle
publication remain pending. See [saved original actions](shared-recovery-action-payloads.md).

Saved manifest storage and image protection now accept `actionMaxBytes` with
the execution read limit. They check all first-recorded inputs against the
combined manifest, including earlier child arguments and skipped children,
while preserving per-set coverage for current executions. All five original
catalog bindings and files remain checked through publication, reservation and
verification. Native tests cover missing original-only requirements, archived
bytes, cleanup handoff, changed evidence, competing writers and failed commits.
Complete history retention and complete bundle publication remain pending. See
[original invocation image protection](recovery-checkpoint-images.md#check-saved-original-invocation-images).

Core now prepares origin, superseded rebase and authoritative runs for currently
selected roots. An independent inventory binds source labels and complete
per-run contexts. Selected runs must match the current materialization, while
deselected runs reconstruct independently. Content checks bind originals,
executions and shared rows. Optional isolated SQL validation checks each run's
before and after states, and per-run manifests cover all rows and actual inputs.
Additional roots and complete bundles remain pending.
See [retained recovery history](shared-recovery-retained-history.md).

Migration 0032 now retains trusted retained-history descriptors with the exact
original local binding and all nested source expectations. Registration requires
all four source catalogs and content verification rechecks all five original
bindings after hashing. This tenth local table survives shared replacement.
Local validation and version 26 JSON exports preserve historical and orphaned
metadata without timestamp conversion. Native and Node WASM tests cover content
changes, coherent replacement, migration and rollback. Native tests cover
competing registrations and JSON import rollback.

The Node host now saves and reopens registered retained-history payloads through
synced exclusive publication. Independent limits bound retained, original,
execution, shared and local reads. All four saved sources and both endpoints of
each retained run undergo content and exact SQL validation. All five original
catalog bindings and four source files remain checked around file work. Native
tests cover independent origin and superseded contexts, skipped executions,
changed evidence, unsafe paths, large inputs, competing writers and publication
or commit failures. Complete bundles remain pending. See
[saved retained history](shared-recovery-retained-payloads.md).

Core now prepares content-bound retained asset payloads with per-run manifests,
original-input requirements and the exact current asset descriptor. Verification
checks all six source payloads and requires complete baseline, effect and actual
invocation coverage in each run's own manifests. Original and selected inputs
also retain independent coverage, while the combined manifest preserves current
local requirements and host extras. See
[retained asset checkpoints](retained-recovery-asset-checkpoints.md).

Migration 0033 now retains trusted retained-manifest descriptors with all six
original source bindings. Registration requires matching live catalogs and
content verification rechecks all seven expectations after hashing. This
eleventh local table survives shared replacement. Local validation and version
26 JSON exports preserve historical and orphaned metadata without timestamp
conversion. Native and Node WASM tests cover changed bindings, coherent
replacement, migration and rollback. Native tests cover competing registrations
and JSON import rollback.

The Node host now saves and reopens registered retained manifests through synced
exclusive publication. Independent limits bound the manifest and all six source
payloads. All seven catalog expectations must match before file reads, and all
six saved sources undergo content and isolated SQL validation before coverage
verification. The original bindings and files remain checked around publication
and reopening. Native tests cover per-run and original image requirements,
matching-hash coverage gaps, large manifests, unsafe paths, changed evidence,
competing writers and publication or commit failures. Complete bundles remain
pending. See
[saved retained manifests](retained-recovery-asset-payloads.md).

The image workflow now accepts retained-history and retained-manifest read limits
with all five earlier source limits. It verifies the saved retained manifest and
all six sources, then carries all seven original catalog bindings and files
through image reservation and verification. Pending protection commits before
physical reads. Native tests cover origin and superseded images, archived bytes,
cleanup handoff, metadata and file changes, failed commits and competing writers.
The stable checkpoint owner refuses changed requirements while preserving earlier
pins. Broader roots now use the separate archive workflow described below.
Complete bundles remain pending. See
[retained-run image protection](recovery-checkpoint-images.md#check-saved-retained-run-images).

Core now prepares original-action archives for roots outside the current
materialization. A separately trusted root and action inventory retains complete
first-record metadata and requires every current original record to remain exact.
Verification owns records and sources before hashing and checks all three current
source payloads. Archives can be nonempty when the current checkpoint has no
actions. Native and Node WASM tests cover unselected roots, nested and skipped
children, sequence strings beyond JavaScript's safe integer range, changed
evidence and image metadata.
Broader execution and effect retention now uses the run archives described below. See
[action archives](shared-recovery-action-archives.md).

Migration 0034 now retains trusted action-archive descriptors with exact original
local bindings. Registration requires all four matching source catalogs.
Verification owns inputs before catalog reads and rechecks all five original
expectations after hashing. The twelfth local table survives shared replacement,
exact local snapshots and version 26 JSON exports. Native and Node WASM tests
cover changed sources, immutable registration, exact timestamp preservation,
historical and orphaned metadata, rollback and migration. Native tests also
cover competing connections and JSON import rollback.

The Node host now saves and reopens registered action archives through synced
exclusive publication. Independent limits bound the archive and all four saved
sources. Source loaders validate exact SQL states, and archive verification
preserves complete first-record inventories and every current original. All five
original catalog bindings and all four source files remain checked around
publication and reopening. Native tests cover unselected roots, nested and
skipped children, checkpoints without selected actions, unsafe paths, changed
evidence, competing writes and publication or commit failures. Complete bundles
remain pending. See
[saved archives](shared-recovery-action-archive-payloads.md).

Core now prepares run archives for roots outside the current materialization.
Descriptors bind the trusted original-action archive, full run inventory and
canonical contents. Verification owns all four sources before hashing, preserves
original root inputs and provider maps, and checks selected runs against current
materialization. Additional origin, rebase and authoritative runs reconstruct
independently. SQL validation checks each run's complete before and after states
and checks the current baseline when no runs are selected. Native and Node WASM
tests cover nested and skipped children, source changes, truncation, input
ownership, exact SQL states, rollback and image metadata. Saved manifests and
image protection now use the host workflows described below. Complete bundles
remain pending. See
[run archives](shared-recovery-run-archives.md).

Migration 0035 now retains trusted run-archive descriptors with exact original
local bindings. Registration requires matching action-archive, original-action,
execution, shared and local catalogs. Content verification owns all inputs before
catalog reads and rechecks all six original expectations after hashing. This
thirteenth local table survives shared replacement, exact local snapshots and
version 26 JSON exports. Native and Node WASM tests cover changed sources,
immutable registration, exact timestamps, historical and orphaned metadata,
migration and rollback. Native tests cover competing registrations and JSON
import rollback. Image protection now uses the broader workflow described below.

The Node host now saves and reopens registered run archives through synced
exclusive publication. Independent limits bound the run file and all five saved
sources. All six original catalog bindings and source files remain checked around
publication and reopening. Source loaders validate exact SQL values, and run
validation checks each complete before and after state. Native tests cover
additional origin, rebase and authoritative runs, nested and skipped executions,
checkpoints without selected actions, changed evidence, unsafe paths, competing
writers and publication or validation commit failures. Complete bundles remain
pending. See
[saved run archives](shared-recovery-run-archive-payloads.md).

Core now prepares asset checkpoints for broader run archives. Descriptors bind
the exact original run and local expectations, current asset descriptor and
canonical contents. Verification owns all seven sources before hashing, checks
every source hash and requires independent per-run row and actual input coverage.
Original-input requirements cover every archived action, including children that
never execute. The exact combined manifest preserves current local images,
pending uploads and host extras. Native and Node WASM tests cover additional
roots, nested and skipped inputs, baseline-only materializations, changed
bindings and source contents, missing coverage, conflicts and input ownership.
Trusted manifest descriptors, saved files and image protection now use the
workflows described below. Complete bundles remain pending. See
[run archive assets](run-archive-asset-checkpoints.md).

Migration 0036 now retains trusted broader run-manifest descriptors. Registration
requires all seven live source catalogs with exact original bindings. Verification
owns all inputs before reads and rechecks all eight original expectations after
hashing. This fourteenth local table survives shared replacement, exact local
snapshots and version 26 JSON exports. Native and Node WASM tests cover immutable
registration, changed sources, historical and orphaned metadata, exact timestamps,
migration and rollback. Native tests cover competing registrations and JSON import
rollback. Saved manifest files now use the host workflow described below.
Broader image protection now uses the workflow described below. Complete bundles
remain pending.

The Node host now saves and reopens registered broader run manifests through
synced exclusive publication. Independent byte limits bound the manifest and all
seven saved sources. All eight original catalog bindings and every source file
remain checked around publication and reopening. Source loaders validate exact
SQL values and every independent run endpoint. Manifest verification checks
per-run coverage, every first-recorded input and the exact combined requirements.
Native tests cover additional runs, never-executed inputs, empty run inventories,
checkpoints without selected actions, changed evidence, unsafe paths, competing
writers and publication or validation commit failures. Complete bundles remain
pending. See
[saved run manifests](run-archive-asset-payloads.md).

The image workflow now accepts explicit broader run and manifest read limits
alongside all saved source limits. It validates complete saved requirements and
carries all eight original catalog bindings and files through reservation and
verification. Pending pins commit before image byte reads. Additional run images,
nested and skipped inputs, never-executed originals and local requirements stay
protected through cleanup after earlier owners are released. Native tests cover
changed evidence, exact source bindings, unsafe or missing images, competing
writers, owner publication changes and failed commits. Earlier pending and
retained protection survives failures. Registered bundle publication now uses
the host workflow described below. Shared-state installation remains pending. See
[broader run images](recovery-checkpoint-images.md#check-saved-broader-run-images).

Core now prepares recovery bundle indexes from all eight original payloads.
The fixed role inventory retains each exact byte length and hash beside the
trusted broader run-manifest checkpoint and combined image requirements.
Verification owns all sources before hashing, checks their actual contents and
independent coverage, and refuses mismatched identities, missing payloads, changed
requirements or rewritten expectations. Native and Node WASM tests cover closed
inventories, historical metadata, unsafe transport, input ownership and exact
source verification. Indexes remain metadata without authorizing publication or
installation. Registered bundle publication now uses the host workflow described
below. Shared-state installation remains pending. See [bundle indexes](recovery-bundle-indexes.md).

The Node host now publishes registered bundle indexes only after validating all
eight saved payloads, independent manifest coverage and protected image bytes.
Pending pins commit before physical image reads. All eight original catalog
bindings and source files remain checked under the image writer lock around byte
verification and synced exclusive index publication. The bounded loader requires
retained protection, rechecks all contents and physical bytes, and preserves index
file identity through validation. Matching final bytes after a failed commit do
not bypass pending-owner refusal. Explicit retries preserve interruption evidence
and earlier pins. Native tests cover missing sources, changed evidence, invalid
limits, unsafe paths, publication and commit failures, cleanup handoff and
competing writes. Automatic capture, shared-state installation and activation remain
pending. See [published bundles](recovery-bundles.md).

Migration 0037 adds destination-owned local installation authority. The singleton
record cannot travel in a portable snapshot or JSON dump and SQL guards prevent
updates or deletion. Portable snapshots retain fourteen tables and JSON stays at
version 26. Shared history excludes the destination record. The core installer
checks complete migration history and canonical destination schema, requires an
empty staging database, validates local contents separately and atomically
commits exact rows with the original bundle descriptor. Matching retries preserve
later edits and conflicting checkpoints are refused. The Node wrapper validates
a published bundle before the first installation and acknowledges later retries
without reopening source files. Native and Node WASM tests cover exact values,
identity mismatches, rollback and metadata isolation. Native tests cover restart,
competing connections and published-bundle integration. Shared-state staging,
image installation and activation remain pending. See
[local installation](local-recovery-installation.md).

## Version one

Complete phases 1–5 before shipping stamping and restoration. Keep guards opt-in
until write coverage and exact restoration checks pass. Treat the adapter
prototype in phase 2 as a gate before finalizing the log format.

### 1. Inventory writes and define action contracts

- [x] Inventory service, record, CLI and system write paths, including direct statements, import, repair and migrations.
- [x] Inventory generated IDs, ORM defaults, SQL clock expressions, business triggers and conflict modes.
- [x] Define the versioned core action registry and type-check coverage against client write classifications.
- [x] Install real transaction-bound service handlers for the declared syncable database kinds and `system.compose` in an opt-in version 1 registry.
- [x] Add version 2 shared taskspace lifecycle handlers for schema 20 while preserving version 1 lifecycle eligibility and recovery semantics.
- [ ] Define complete invocation envelopes, including routing and target IDs, for every registered kind.
- [ ] Classify each kind as `syncable` or `local-only` and define its replay or file recovery handler.
- [ ] Define stable binding paths for entity IDs, child action IDs and clock readings. Preserve bindings when query ordering changes.
- [x] Bind IDs in the covered record helpers and clocks in single and batch card creation and text updates when called through opt-in action handles.
- [x] Bind squash inventory and piece IDs and their shared timestamp to the source card and segment roles.
- [x] Bind taskspace record IDs, creation timestamps and label clocks through opt-in execution handles without allocating clocks for location updates.
- [ ] Persist `contract_ver` from the first execution and dispatch the whole group through its compatible registry.
- [ ] Refuse unbound replay allocations without changing the binding map. Preserve original invocations when replay resolves child arguments differently.
- [ ] Replace migration 0019's timestamp fallback with explicit bindings and record-mode validation. Preserve historical timestamps during restoration.
- [ ] Verify complete envelopes, changed replay branches, import timestamp normalization and contract compatibility.

### 2. Prove capture and restoration on every adapter

- [ ] Prototype persistent `BEFORE` capture with an unconstrained row projection on every supported adapter.
- [x] Implement the tagged row-value codec for baseline rows, primary keys and full effect images.
- [x] Integrate test-only capture across all application tables with real service actions, execution attribution and full projection read-back on libsql and Node WASM.
- [ ] Verify signed 64-bit integers without JavaScript number conversion, storage classes, finite REAL bits, NULL, Unicode text, embedded NUL characters and blobs.
- [ ] Refuse malformed encodings and unsupported baseline or stamped values without changing application data.
- [ ] Verify capture order for nested triggers, repeated updates, FK cascades and intermediate row images under different trigger creation orders.
- [ ] Verify projection reconstruction and lossless installation together. Refuse activation on an adapter that cannot satisfy the codec contract.
- [ ] Add action, effect-set, execution and persistent context tables after the prototype passes.
- [ ] Implement root and child attribution with separate group-wide execution and effect counters. Include children with no row effects.
- [ ] Keep origin effect sets immutable and retain execution records for each later execution.
- [x] Add shared connection configuration and verification, and check both flags before handlers and after completion in opt-in action scopes.
- [ ] Verify `foreign_keys` and `recursive_triggers` on every supported adapter at runtime. Libsql and Node WASM pass. Browser execution remains pending.
- [ ] Restrict mutating business triggers to `AFTER` execution. Refuse primary-key changes and unsupported skipped-write behavior.
- [ ] Verify unstamped raw writes fail and marker cleanup survives success, rollback and failed commit.

### 3. Route writes through stamped boundaries

- [ ] Wrap every service write in a stamped adapter transaction, including direct layer creation and rename.
- [x] Add caller-owned transaction variants for stacking, squash, layer and partition removal, board scope removal and namespace administration.
- [x] Add transaction-bound taskspace database APIs and separate label changes from local observations at the record API boundary.
- [x] Expose database-only taskspace services with namespace validation and shared responses, and verify version 2 composition replay without local metadata or filesystem access.
- [ ] Require active action groups in transaction-bound record and service methods.
- [x] Require matching live execution scopes for real service registry dispatch and enforce ORM write restrictions through opted-in handles.
- [x] Define and register the opt-in `system.repair` action for explicitly requested inventory repair.
- [ ] Add stamped import and route CLI repair operations through persistent action boundaries.
- [x] Replace no-op upserts with existence checks inside serialized write transactions.
- [x] Implement `system.compose` with read helpers, a registered dispatcher and a serialized ordered list of direct children. The implementation is opt-in; caller migration remains pending.
- [ ] Migrate composition callers that use direct SQL or need replayed control flow to dispatcher calls or named handlers.
- [x] Enforce handler ownership, sequential child calls and refusal of parent SQL while a child is active in opted-in execution scopes.
- [x] Add a root failure latch that survives caught child errors and SQL savepoints, and check it before transaction commit.
- [x] Integrate fresh execution scopes with root replay savepoints and check the latch before savepoint release in opt-in replay transactions.
- [x] Wait for outstanding children and service work to settle before rollback and discard each failed root's execution scope.
- [ ] Separate filesystem handlers from syncable database handlers. Refuse local-only children in generic compositions and named syncable handlers.
- [x] Move taskspace paths and observations into local metadata storage before baseline capture. Preserve metadata for absent taskspaces without cascading deletion.
- [x] Keep shared taskspace rename independent of directory movement and local observation timestamps.
- [ ] Verify write coverage, caught failures, overlapping calls, outstanding children, nested execution order and serialized composition replay.
- [x] Verify all five taskspace file methods remain local-only and cannot mutate shared application rows.
- [ ] Verify shared restoration preserves local taskspace metadata and installs no remote directory attachments.

### 4. Implement baselines, restoration and migration recovery

- [x] Derive and test an internal acyclic restoration load plan from schema metadata and refuse unsupported table dependencies.
- [x] Prototype isolated application projection validation with constraints, trigger invariants and exact read-back on libsql and Node WASM.
- [x] Prototype atomic populated-row replacement and selected-history bookkeeping with active guards, suppressed mutation triggers and rollback checks on libsql and Node WASM.
- [x] Verify populated migration, hidden retained taskspace attachments and shared restoration without remote attachment installation on libsql and Node WASM.
- [ ] Add workspace and epoch identities, schema and encoding versions, baseline hashes and restoration selections.
- [ ] Implement restartable initial baseline capture for populated and seeded databases with application writes blocked until activation.
- [ ] Reconstruct the target projection from the baseline and selected complete effect sets in materialization order. Check every full before image.
- [x] Expose pure shared reconstruction from a complete baseline and selected effect records. Require separately trusted IDs, order and expected counts, reject truncation and ordinal gaps, and compare full tagged before images without SQL coercion. Verify captured cascades on native and Node WASM adapters.
- [x] Bind canonical shared row-history payloads to checkpoint identities, selected IDs, counts, UTF-8 byte lengths and SHA-256 hashes. Verify separately retained descriptors before SQL allocation and preserve exact intermediate effects, TEXT cells and caller-owned inputs while hashing.
- [x] Persist shared-history descriptors with their original registered local checkpoint expectations. Serialize immutable registration, recheck both trusted catalog bindings after isolated validation, preserve records through local snapshots and version 26 JSON exports, and verify rollback, migration and competing connections.
- [x] Save registered shared row-history payloads with synced exclusive publication and read-only interruption inspection. Reopen only published bytes within a host size limit, validate exact SQL values and recheck the original catalog pair and file identity without installing rows or consuming temporary evidence.
- [ ] Validate target rows in an isolated database with the epoch's constraints, foreign keys and trigger-enforced invariants.
- [x] Expose complete shared projection parsing and isolated SQL validation for the bundled schema. Keep validation constraints active, compare exact tagged read-back and roll back temporary rows and business-trigger changes before success on native and Node WASM adapters.
- [ ] Read back loaded validation rows with the tagged codec and compare them with the target projection, including storage classes and exact REAL bits. Refuse installation or activation on any mismatch.
- [ ] Define the epoch's acyclic foreign-key load order and refuse unsupported schemas before changing live rows.
- [ ] Implement trusted restore mode with active guards and suppressed capture, mutating business triggers and timestamp normalization.
- [ ] Stage standalone restoration and atomically activate it only after validation and installation of its required history and bookkeeping.
- [ ] Implement replacement of shared rows inside one reconciliation transaction while preserving local metadata and log tables.
- [ ] Rebuild derived data after installation. Keep requested repair separate from exact restoration.
- [ ] Capture full local recovery snapshots and shared checkpoint selections from one consistent database read transaction.
- [x] Add an internal versioned local snapshot format and capture helper with complete table coverage, exact tagged values, checkpoint selection and identity checks. Verify concurrent checkpoint reads and refuse malformed transport without changing source data.
- [x] Validate local snapshot rows in a separate empty database under canonical SQL constraints. Compare exact tagged read-back, roll back temporary rows and refuse success after connection, cleanup or commit failures.
- [x] Collect local checkpoint image requirements and merge selected shared-history manifests. Reject malformed active or inactive metadata and immutable name conflicts before SQL validation. Verify recovery-owner pins through cleanup and missing-file verification.
- [x] Bind local checkpoints to canonical snapshot hashes and UTF-8 byte lengths. Verify separately retained descriptors before SQL allocation, preserve exact TEXT and materialization order, and hash captured snapshots after the consistent read boundary closes.
- [x] Persist trusted checkpoint descriptors in a local catalog with immutable identity bindings and idempotent registration. Preserve historical metadata through shared restoration and recovery exports, and verify competing registrations, rollback and migration.
- [x] Resolve snapshot validation expectations from the trusted catalog and recheck their binding after isolated validation. Refuse transport-supplied expectations, missing registrations and changed bindings without installing local rows.
- [x] Save original registered local snapshot payloads with synced temporary files, exclusive immutable publication and read-only interruption evidence. Refuse unsafe paths and changed contents, serialize catalog binding checks and preserve files after failed outer commits.
- [x] Read published registered payloads with an explicit host byte limit and expected identity. Verify canonical bytes and exact SQL values, refuse temporary evidence and recheck file identity and catalog binding after isolated validation without installing rows.
- [x] Connect saved registered payloads to stable recovery image owners. Check selected history IDs, commit pending protection before byte verification and preserve it after missing files or failed verification commits. Verify cleanup handoff and competing releases without publishing incomplete bundles.
- [x] Check shared manifests against baseline and full effect images while preserving extra invocation requirements. Validate both saved payloads before image reservation, recheck both files and catalog bindings under the image writer lock, and preserve earlier protection after verification or commit failures.
- [x] Bind per-record history manifests and combined image requirements to the original shared/local descriptor pair with canonical asset payloads. Verify independently retained content expectations, both source hashes and exact coverage while owning inputs before hashing.
- [x] Persist trusted asset descriptors with immutable original checkpoint bindings. Require both live source catalogs before registration, recheck all three catalogs after content verification and preserve orphaned metadata, exact local snapshots and version 26 JSON exports. Verify migration, rollback and competing connections.
- [x] Save and reopen registered asset-manifest payloads with synced exclusive publication and independent host limits for all three payloads. Validate both saved sources, canonical manifest contents and exact coverage, recheck all original bindings and files, and preserve interruption evidence after filesystem or commit failures without installing images.
- [x] Connect registered saved manifests to image reservation and protected byte verification. Carry all three original catalog bindings and files through reservation and verification, reject ambiguous inputs and preserve earlier owners after changed requirements, failed reads, verification or commits. Verify cleanup handoff, archived invocation-only bytes and competing writes.
- [x] Prepare selected execution records with independently trusted root IDs and counts. Bind finalized invocations, used and unused allocations, no-op children and complete effect attribution to the original shared checkpoint. Verify sequential trees, invocation image coverage, transport ownership and real captured scopes on native and Node WASM adapters without invoking handlers.
- [x] Persist trusted execution descriptors with original local checkpoint bindings. Require live matching shared and local expectations, recheck all three catalogs after verification and retain exact metadata through shared replacement, local validation and version 26 JSON exports. Verify orphaned inspection, migration, rollback and competing connections.
- [x] Save and reopen registered execution payloads with synced exclusive publication and independent limits for execution, shared and local reads. Validate both saved sources and execution attribution, recheck all three original catalog bindings and files, and preserve evidence after filesystem or commit failures. Verify unsafe paths, large inputs, exact source SQL values and competing writers without invoking handlers or installing rows.
- [x] Connect saved execution payloads to asset save/load and protected image verification through an explicit host byte limit. Require per-set root and child image coverage, including no-op and zero-effect records. Carry all four original catalog bindings and files through publication, reservation and verification while preserving interruption evidence and earlier owners after failures.
- [x] Prepare original action records with an independently trusted ID selection, first-recorded inputs and bindings, exact local sequence strings and provenance. Bind contents to the original execution descriptor, require stable root inputs and provider maps, preserve changed and skipped child inputs separately and check original invocation image requirements without running handlers.
- [x] Persist trusted original-action descriptors with exact original local bindings. Require matching live execution, shared and local sources, recheck all four catalogs after verification and preserve historical or orphaned expectations through shared replacement, exact local validation and version 26 JSON exports. Verify migration, rollback and competing registrations.
- [x] Save and reopen registered original-action payloads with synced exclusive publication and independent read limits for originals and all three saved sources. Verify original contents, source hashes, attribution and exact source SQL values. Recheck all four original catalog bindings and files, preserve interrupted evidence and refuse changed originals without running handlers or installing rows.
- [x] Connect saved originals to manifest storage and protected image verification through an explicit host byte limit that requires saved execution coverage. Check first-recorded and skipped inputs against the combined manifest while preserving current per-set coverage. Carry all five original catalog bindings and files through publication, reservation and verification and preserve earlier protection after failures.
- [ ] Retain required history and assets while assembling recovery bundles. Publish only complete bundles.
- [x] Prepare retained origin, superseded rebase and authoritative effect sets for selected roots with a separately trusted inventory, complete per-run before-states and row and execution records. Bind original and selected source hashes, check selected contexts against materialization, validate both endpoints in isolated SQL databases and collect per-run image requirements without applying deselected runs.
- [x] Persist trusted retained-history descriptors with exact original local bindings and nested original, execution and shared expectations. Require all four live source catalogs, recheck all five bindings after content verification and preserve historical and orphaned metadata through shared replacement, local validation and version 26 JSON exports. Verify migration, rollback and competing registrations.
- [x] Save and reopen registered retained-history payloads with synced exclusive publication and independent read limits for retained data and all four sources. Validate per-run before and after SQL states, original and selected source contents, all five original catalog bindings and four saved source files. Preserve interrupted evidence after changed files, unsafe paths, competing writers and publication or commit failures.
- [x] Bind canonical per-run retained manifests and first-recorded input requirements to the exact retained-history binding and current asset descriptor. Verify all six source payloads, independent baseline and effect coverage for every run, original and selected invocation coverage, and the exact combined manifest including local requirements and host extras. Own all sources before hashing and preserve historical descriptors as metadata.
- [x] Persist trusted retained-manifest descriptors with exact original retained-history, local and current asset bindings. Require all six live source catalogs, recheck all seven expectations after content verification and preserve historical and orphaned metadata through shared replacement, isolated local validation and version 26 JSON exports. Verify migration, rollback and competing registrations.
- [x] Save and reopen registered retained manifests through synced exclusive publication with independent read limits for the manifest and all six saved sources. Check all seven original catalog bindings, validate exact source SQL states and per-record coverage, recheck source and manifest files and preserve interrupted evidence after unsafe paths, changed bytes, competing writers and publication or commit failures.
- [x] Connect saved retained manifests to image reservation and protected byte verification through explicit retained-history and retained-manifest read limits with all saved source limits. Carry all seven original catalog bindings and files through reservation and verification. Commit pending pins before physical reads and preserve earlier protection after changed evidence, failed verification or commits, cleanup handoff and competing writes.
- [x] Prepare original-action archives with independent root and action inventories, including roots outside the current materialization and skipped descendants. Preserve every current original record exactly, validate first-record order and provider relations, bind canonical contents to the current original descriptor and verify all three source payloads. Collect complete archived-input image requirements without selecting or executing additional roots.
- [x] Persist trusted action-archive descriptors with exact original local bindings. Require all four live source catalogs, own inputs before reads and recheck all five expectations after verification. Preserve historical and orphaned metadata through shared replacement, exact local snapshots and version 26 JSON exports. Verify migration, rollback and competing registrations.
- [x] Save and reopen registered action archives through synced exclusive publication with independent limits for the archive and all four saved sources. Validate source SQL states, complete first-record inventories and exact current originals. Recheck all five original catalog bindings and saved source files, preserve archive file identity and retain interrupted evidence after unsafe paths, changed contents, competing writes and publication or commit failures.
- [x] Prepare run archives bound to broader original-action expectations with independent trusted run inventories. Preserve selected contexts, validate all four sources and every nested run hash, check exact original root inputs and provider maps, validate all before and after SQL states and the current baseline when no runs are selected, and collect per-run image requirements without applying additional runs.
- [x] Persist trusted run-archive descriptors with exact original local bindings. Require all five live source catalogs, own inputs before reads and recheck all six original expectations after content verification. Preserve historical and orphaned metadata through shared replacement, exact local snapshots and version 26 JSON exports. Verify migration, rollback and competing registrations.
- [x] Save and reopen registered run archives through synced exclusive publication with independent limits for the run file and all five sources. Validate exact source SQL values and every independent run endpoint, recheck all six original catalog bindings and saved source files, preserve run file identity and retain interrupted evidence after unsafe paths, changed contents, competing writers and publication or validation commit failures.
- [x] Bind per-run manifests and all archived first-record input requirements to the exact run archive binding and current asset descriptor. Verify all seven source payloads, independent baseline, full effect and actual invocation coverage, and the exact union with current local requirements and host extras. Preserve never-executed inputs, own all sources before hashing and keep historical descriptors readable as metadata.
- [x] Persist trusted broader run-manifest descriptors with exact original bindings. Require all seven live source catalogs, own inputs before reads and recheck all eight expectations after verification. Preserve historical and orphaned metadata through shared replacement, exact local validation and version 26 JSON exports. Verify migration, rollback and competing registrations.
- [x] Save and reopen registered broader run manifests through synced exclusive publication with independent limits for the manifest and all seven sources. Validate exact source SQL values, every independent run endpoint and complete per-record image coverage. Recheck all eight original catalog bindings and every source file, preserve manifest file identity and retain interrupted evidence after unsafe paths, changed contents, competing writes and publication or validation commit failures.
- [x] Connect saved broader run manifests to image reservation and protected byte verification. Carry all eight original catalog bindings and files through reservation and verification, preserve current and per-run invocation coverage, and retain earlier protection after failures.
- [x] Prepare recovery bundle indexes binding all eight exact payload references and complete image requirements to an independently trusted descriptor. Verify every source, fixed role coverage, full host identity and independent per-record requirements while owning inputs before hashing. Preserve historical metadata without authorizing publication or installation.
- [x] Publish bundle indexes only after all eight saved payloads and required image bytes are validated and protected. Preserve interrupted evidence and refuse incomplete artifacts.
- [x] Validate device, workspace, epoch and checkpoint identities before loading a local snapshot once. Refuse complete recovery with a missing or mismatched snapshot.
- [x] Persist one immutable destination installation record outside portable local snapshots, shared projections and JSON exports. Preserve it through JSON imports and refuse transported authority, conflicting descriptors, unsupported schemas and incomplete migration history.
- [x] Install exact local rows and the destination record in one commit after isolated validation. Preserve absent metadata and pending operations, verify tagged read-back and rollback, serialize competing writers and acknowledge matching retries without replaying later edits.
- [ ] Support explicit shared-only recovery and inspect pending file operations without automatically repeating filesystem changes.
- [ ] Add durable epoch transitions that block application writes across connections and restarts.
- [ ] Implement trusted migrate mode and atomic migration batches covering schema, data, migration history, progress and mode cleanup.
- [ ] Resume incomplete transitions without rerunning committed repair. Validate guards and rows before atomically activating the new baseline.
- [ ] Verify baseline replay against the compatibility corpus, populated workspace upgrades, restoration constraints, corrupt images and interrupted activation.
- [ ] Verify validation rejects loaded rows whose storage classes or REAL bits differ from the target projection, even when constraints pass. Preserve the existing destination on failure.
- [ ] Verify consistent local recovery snapshots and migration interruption before and after each durable boundary.

### 5. Record filesystem operations and protect assets

- [ ] Add pending and confirmed local file-operation records with affected paths and intended content hashes where applicable.
- [x] Journal taskspace directory claims before disk work, atomically confirm local attachments, retain interrupted evidence and report it through `doctor` without retrying callbacks. See [local filesystem operation records](local-file-operations.md).
- [x] Journal all five file mutation methods with intended hashes where applicable, preserve evidence after statement and commit failures, and inspect disk state without retrying callbacks.
- [x] Journal managed-directory deletion and legacy combined rename, retain marker and directory identity evidence, and commit shared changes and confirmation atomically.
- [x] Journal CLI layout moves and intermediate paths, atomically confirm attachment updates, and retain completed disk changes instead of unrecorded compensating moves.
- [x] Add explicit abandonment of reviewed pending operations while retaining intent, errors, reason and timestamp. Refuse automatic retries of pending layout work.
- [x] Recover completed directory moves, layout changes and removals with snapshot and disk checks, atomic database confirmation and no filesystem retries. Preserve blocked and failed recovery evidence.
- [x] Inspect interrupted taskspace file operations against disk state on startup and explicitly confirm reviewed outcomes without repeating filesystem callbacks. Preserve recorded errors and blocked evidence.
- [x] Inspect pending directory claims on authenticated server startup and provide explicit attachment confirmation with live marker, identity and attachment checks. Preserve blocked claims without repeating filesystem work.
- [ ] Add asset manifests to baselines and effect sets, covering references in invocations and full before and after images.
- [x] Add internal image-manifest collection, canonical validation, byte verification and collision checks. Verify requirements from real captured history on native and WASM adapters.
- [x] Persist manifests with prototype baselines and completed effect sets. Reopen stored history, verify selected bytes before restoration, and refuse changed history or failed manifest commits without replacing rows.
- [x] Reserve image names with durable staging pins before files become visible, then write and verify their bytes.
- [ ] Commit image references, manifests and staging completion together. Preserve staging pins after rollback.
- [x] Complete installed upload pins with application card create and update transactions. Preserve immutable metadata and pin protection after statement or commit failures.
- [ ] Serialize file installation, staging transitions and cleanup decisions so protection transfers without a gap.
- [x] Serialize local upload installation, card-reference pin transfer and cleanup with the database writer lock. Preserve pending files and deletion requests during contention and rollback.
- [ ] Protect assets needed by live rows, uploads, staged transfers, pending work, retained history and recovery records.
- [x] Add durable local manifest reservations, protected byte verification and explicit owner release. Make cleanup honor every registered owner and preserve local protection through shared restoration.
- [x] Connect prototype baseline and effect-set publication to local manifest ownership. Verify protected files, atomic staging handoff and upload completion, cleanup contention and retained images after history is deselected.
- [x] Recover verified published uploads or explicitly abandon reviewed pins without repeating filesystem work. Preserve intent, errors and decisions, and keep live references protected during cleanup.
- [ ] Verify cleanup races and crashes before file creation, after installation and after action commit.
- [ ] Enable mandatory guards and ship version one only after phases 1–5 and their verification pass.

## Later sync work

Settle phase 6 before implementing the sync protocol. Keep transport, conflict UI
and character-level text merging outside version one.

### 6. Resolve sync policy questions

- [ ] Choose the first sync setting from own devices, shared team workspaces or browser and offline use.
- [ ] Define semantic conflict rules for inventory placement, stacking and layer order, scope names and default namespaces.
- [ ] Define concurrent text edit ordering and durable preservation of losing text.
- [ ] Define retention and compaction policies for baselines, history and outcome receipts.
- [ ] Define recovery of offline pending work across schema epoch changes.
- [ ] Define deletion and text purge behavior across baselines, effects, inputs, recovery records and remote copies.
- [ ] Set retry limits and backoff for temporary failures and contention.

### 7. Add sync setup and durable state

- [ ] Implement resumable hub initialization from a populated workspace using a new baseline, verified asset manifest and idempotent setup identity.
- [ ] Archive existing origin history and start empty submission and materialization lists only after matching hub initialization succeeds.
- [ ] Stage joining an existing hub in a separate destination and activate only after verified installation.
- [ ] Preserve pending work on baseline-required responses and stop unsupported epoch recovery without replacing the workspace.
- [ ] Add durable confirmed cursors, queues, accepted-group mappings, receipts and ordered materialization selections.
- [ ] Track hub outcomes independently from local materialization, including blocked pending roots.
- [ ] Freeze each submitted root's contract version, envelope, bindings and dependencies with its canonical payload hash.
- [ ] Register and enforce conservative shared-table read and mutation footprints, including descendants, triggers and composition callback reads.
- [ ] Derive dependencies on earlier pending roots and require prerequisites to be materialized before local execution.
- [ ] Revalidate dependencies before submission and refuse changes to frozen dependency lists afterward.
- [ ] Persist entire prerequisite closures in unresolved state atomically before sending requests. Recover committed obligations even if no request was sent before a crash.
- [ ] Verify setup interruption, identity mismatches, dependency discovery, submission races and out-of-order prerequisite delivery.

### 8. Implement hub acceptance and asset transfer

- [ ] Upload and verify missing image bytes before replay. Keep missing assets retryable and refuse name and hash collisions.
- [ ] Check durable outcomes before contract compatibility or replay and return original receipts for identical retries.
- [ ] Check contract compatibility and frozen dependencies before domain execution. Keep unknown prerequisites retryable.
- [ ] Replay each root through its versioned registry inside a root savepoint without filesystem effects.
- [ ] Atomically commit authoritative executions, effects, manifests, `hub_seq` and acceptance receipts.
- [ ] Roll back permanently failed roots completely and persist only rejection receipts. Leave infrastructure failures retryable without permanent outcomes.
- [ ] Retain deduplication state for retried IDs and require bootstrap when compaction removes that state.
- [ ] Stage and verify downloads before bootstrap activation or reconciliation. Pin staged assets and keep network transfers outside database transactions.
- [ ] Verify idempotency, concurrent duplicates, payload mismatch refusal, failure isolation, unsupported contracts and interrupted or corrupt downloads.

### 9. Implement spoke reconciliation and expose sync

- [ ] Serialize cycles that pull through a fixed head, push prepared roots and pull again. Page only on complete root boundaries.
- [ ] Preflight replay contract compatibility and reconstruct confirmed state before replaying pending roots.
- [ ] Match authoritative root IDs against submitted work before pending replay, including blocked roots and lost-response cases.
- [ ] Apply rejection receipts through reconciliation even when no new groups arrive. Preserve origin effects, reasons and rejected text for recovery.
- [ ] Reject unsubmitted dependents locally and keep submitted dependents blocked until their hub outcomes resolve.
- [ ] Replay eligible pending roots in dependency order with separate savepoints and fresh execution scopes.
- [ ] Roll back failed replays completely. Move permanently failed unsubmitted roots to local recovery. Keep unresolved or accepted roots pending and blocked, and keep temporary failures pending. Preserve invocations, origin effects and failure reasons, and continue outcome recovery for unresolved roots.
- [ ] Create new rebase sets without overwriting origin history and omit blocked roots from the replacement materialization list.
- [ ] Commit shared rows, replay sets, queues, receipts, selections and `confirmed_seq` atomically. Keep receipt-only cursors unchanged.
- [ ] Verify own-action echoes, hub rejection application, uncertain submission, restoration after rebase and reconciliation crash recovery.
- [ ] Verify permanent local replay failures move unsubmitted roots to recovery while unresolved or accepted roots remain pending and blocked. Verify temporary failures stay pending and later authoritative acceptance materializes blocked roots exactly once.
- [ ] Simulate random offline edits and sync ordering across multiple spokes. Require convergence and recoverable rejected work.
- [ ] Expose the sync endpoint and `kozane sync <remote>` only after restoration and convergence checks pass.
