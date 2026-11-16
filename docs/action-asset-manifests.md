# Image manifests for retained action data

The internal `packages/core/src/actions/asset-manifest.ts` module collects image
requirements and verifies their bytes. It supports baseline and effect-set builders
without choosing a filesystem adapter or changing application rows.

`baselineAssetNames` scans every TEXT cell in tagged baseline rows for exact
`kozane-image:/api/images/<name>` references. This conservative scan includes
hidden and inventory cards. It ignores embedded URLs, external images, blobs and
ordinary text. `effectAssetNames` scans original invocations, child inputs and
every full before and after image. An intermediate or deleted image remains
required even when the final database contains no reference to it. Invalid row
encodings and non-JSON invocation data are refused.

Both collectors return sorted, distinct workspace-relative names under
`.kozane/assets/images/`. Names use the existing image-reference grammar. Paths
that escape that directory, unsupported extensions and absolute names are refused.

## Build and verify a manifest

`buildAssetManifest` accepts required names and a host reader that returns bytes.
The reader may resolve live or retained files. The builder reads each distinct name
once and returns only after all required assets are available. Missing assets or
unsupported byte lengths reject the build. It does not return a partial manifest.

Version 1 entries contain these fields.

| Field | Meaning |
| --- | --- |
| `name` | Workspace-relative image path |
| `byteLength` | Integer length from 1 byte through `IMAGE_MAX_BYTES` |
| `sha256` | SHA-256 digest of the bytes, encoded as lowercase hexadecimal |

The builder uses Web Crypto and copies read buffers before hashing. It verifies
byte identity rather than image syntax. Upload validation remains responsible for
checking file formats. `parseAssetManifest` validates the version, exact object
shape, names, lengths and hashes. It rejects duplicate names and accessors without
invoking serialization hooks. Parsing returns immutable copies in canonical name
order, so JSON serialization is independent of input field and entry order.

`verifyAssetManifest` first checks exact coverage against independently collected
requirements. It then reads and checks every length and hash. Missing, extra or
corrupt assets prevent successful verification. The required names and manifest
fields are copied before awaiting host reads.

`mergeAssetManifests` combines requirements from retained baselines and history.
An identical entry may appear in several source manifests. Different lengths or
hashes under one name are refused because image names identify immutable bytes.

`selectAssetManifest` chooses the exact required subset of a staged catalog and
refuses missing entries. It validates and copies metadata without reading files.
The host must verify and protect the catalog's bytes before entering a database
action. Selection alone does not establish that the files are available.

## Current integration

The capture prototype stores tagged baseline rows, their encoding version and
their manifest together in `capture_baseline`. Action completion attaches a
manifest to `capture_run` in the same transaction as the shared changes, finalized
effects, invocations and materialization selection. A completed run requires a
manifest, including an explicit empty manifest when no images are needed.

Pass a staged catalog to `installCapturePrototype` or an individual `hooks` call.
Completion chooses only the required entries and refuses missing metadata. It
also rejects name collisions with the baseline or any retained completed run,
including runs outside the current materialization selection. Statement and
commit failures roll back the action and manifest together.

`openCapturePrototype` reopens the stored baseline without reinstalling guards.
Reconstruction reads the baseline and selected history from SQL. It independently
collects required names and checks each attached manifest for exact coverage.
Unsupported encodings and incomplete metadata prevent reconstruction.

Restoration requires a host asset reader when selected data needs images. It
checks all selected manifests and bytes before creating the validation database
or replacing rows. Host reads run outside SQLite transactions. Before installing
rows, it rechecks the stored baseline, history and current selection. Changes
during asset preparation refuse installation and preserve the newer state.
Assets used only by unselected history are not required for that restoration.

Native and WASM tests retain an image updated and deleted in one action, plus an
image referenced only by its invocation. Other tests cover reopening history,
failed manifest commits, missing or corrupt bytes, changed catalogs and concurrent
history changes. Failed verification preserves rows, local metadata and selection.

These tables and guards exist only in test databases. Production baseline and
effect-set attachment, transfer staging, protection for retained history and
recovery-bundle publication remain pending. Local upload reservation and cleanup
now use [staging pins](image-upload-staging.md). Hosts must protect
files across collection, reading and publication. Verification alone does not
provide that protection. The prototype does not enable production action logging
or change image cleanup.
