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

## Current integration

Native and WASM tests collect manifests from real captured baseline rows and
effects. They retain an image that was updated and deleted in one action, plus an
image referenced only by its original invocation. Missing retained bytes fail
verification without changing live rows. Baseline restoration preserves the
original image requirement.

These helpers do not persist manifests, pin files or change cleanup. Production
baseline and effect-set attachment, durable upload and transfer staging, serialized
cleanup protection and recovery-bundle publication remain pending. Builders that
use these helpers still need to protect files across collection, reading and
publication. Verification alone does not provide that protection.
