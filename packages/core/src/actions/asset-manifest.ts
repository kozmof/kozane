/** Image requirements for retained baselines and effects, independent of filesystem adapters. */
import { IMAGE_MAX_BYTES, imagePath } from "../images.js";
import { prepareInput } from "../services/prepare-input.js";
import { parseTaggedRow, type TaggedRow } from "./row-codec.js";
import type { ProjectionEffect, ProjectionRow } from "./projection.js";

export const ASSET_MANIFEST_VERSION = 1;
const directory = ".kozane/assets/images/";
export interface AssetManifestEntry {
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface AssetManifest {
  readonly version: typeof ASSET_MANIFEST_VERSION;
  readonly entries: readonly AssetManifestEntry[];
}
export type ReadAsset = (name: string) => Promise<Uint8Array>;
export class AssetManifestError extends Error {
  override readonly name = "AssetManifestError";
}

function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.startsWith(directory) &&
    imagePath("kozane-image:/api/images/" + name.slice(directory.length)) !== null
  );
}
function names(input: readonly string[]): readonly string[] {
  if (input.some((name) => !validName(name)))
    throw new AssetManifestError("Invalid image asset name");
  return Object.freeze([...new Set(input)].sort());
}
function reference(value: string, output: Set<string>) {
  const path = imagePath(value);
  if (path) output.add(directory + path.slice("/api/images/".length));
}
function image(row: TaggedRow, output: Set<string>) {
  for (const value of Object.values(parseTaggedRow(row)))
    if (value[0] === "text") reference(value[1], output);
}

/** Conservatively retain exact image references in every TEXT cell, including hidden cards. */
export function baselineAssetNames(rows: readonly ProjectionRow[]): readonly string[] {
  const output = new Set<string>();
  for (const row of rows) image(row.row, output);
  return names([...output]);
}

/** Include original invocations, child inputs and images that disappear before the final state. */
export function effectAssetNames(
  invocations: readonly unknown[],
  effects: readonly Pick<ProjectionEffect, "before" | "after">[],
): readonly string[] {
  const output = new Set<string>();
  function walk(value: unknown) {
    if (typeof value === "string") reference(value, output);
    else if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) walk(child);
  }
  for (const invocation of invocations) walk(prepareInput(invocation));
  for (const effect of effects) {
    if (effect.before !== null) image(effect.before, output);
    if (effect.after !== null) image(effect.after, output);
  }
  return names([...output]);
}

/** Inspect plain transport data without invoking getters or serialization hooks. */
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== fields.length
  )
    throw new AssetManifestError("Invalid asset manifest object");
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field);
    if (!property || !("value" in property) || !property.enumerable)
      throw new AssetManifestError("Asset manifest must contain plain data");
    output[field] = property.value;
  }
  return output;
}
function manifest(entries: readonly AssetManifestEntry[]): AssetManifest {
  return Object.freeze({
    version: ASSET_MANIFEST_VERSION,
    entries: Object.freeze(
      [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ),
  });
}

/** Validate transport and return canonical ordering and immutable copies. Duplicate names are invalid. */
export function parseAssetManifest(input: unknown): AssetManifest {
  const value = object(input, ["version", "entries"]);
  if (value.version !== ASSET_MANIFEST_VERSION)
    throw new AssetManifestError("Unsupported asset manifest version");
  const entries = value.entries;
  if (!Array.isArray(entries) || Reflect.ownKeys(entries).length !== entries.length + 1)
    throw new AssetManifestError("Invalid asset manifest entries");
  const seen = new Set<string>();
  const output: AssetManifestEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    const property = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!property || !("value" in property) || !property.enumerable)
      throw new AssetManifestError("Asset entries must contain plain data");
    const entry = object(property.value, ["name", "byteLength", "sha256"]);
    if (
      !validName(entry.name) ||
      !Number.isSafeInteger(entry.byteLength) ||
      (entry.byteLength as number) < 1 ||
      (entry.byteLength as number) > IMAGE_MAX_BYTES ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new AssetManifestError("Invalid asset manifest entry");
    if (seen.has(entry.name)) throw new AssetManifestError(`Duplicate asset name: ${entry.name}`);
    seen.add(entry.name);
    output.push(
      Object.freeze({
        name: entry.name,
        byteLength: entry.byteLength as number,
        sha256: entry.sha256,
      }),
    );
  }
  return manifest(output);
}

async function describe(name: string, read: ReadAsset): Promise<AssetManifestEntry> {
  const loaded = await read(name);
  if (
    !ArrayBuffer.isView(loaded) ||
    Object.prototype.toString.call(loaded) !== "[object Uint8Array]" ||
    loaded.byteLength < 1 ||
    loaded.byteLength > IMAGE_MAX_BYTES
  )
    throw new AssetManifestError(`Invalid image asset length: ${name}`);
  // Own the digest input even if the host later reuses or changes its read buffer.
  const bytes = new Uint8Array(loaded);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    name,
    byteLength: bytes.byteLength,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  });
}

/** Read every required asset before returning a complete manifest. A missing read rejects the build. */
export async function buildAssetManifest(
  required: readonly string[],
  read: ReadAsset,
): Promise<AssetManifest> {
  const entries: AssetManifestEntry[] = [];
  for (const name of names(required)) entries.push(await describe(name, read));
  return manifest(entries);
}

/** Verify complete coverage and actual bytes before a caller activates a baseline or history set. */
export async function verifyAssetManifest(
  input: unknown,
  required: readonly string[],
  read: ReadAsset,
): Promise<AssetManifest> {
  const parsed = parseAssetManifest(input);
  const expected = names(required);
  if (
    parsed.entries.length !== expected.length ||
    parsed.entries.some((entry, index) => entry.name !== expected[index])
  )
    throw new AssetManifestError("Asset manifest does not cover exactly the required names");
  for (const entry of parsed.entries) {
    const actual = await describe(entry.name, read);
    if (entry.byteLength !== actual.byteLength || entry.sha256 !== actual.sha256)
      throw new AssetManifestError(`Asset bytes do not match manifest: ${entry.name}`);
  }
  return parsed;
}

/** Combine retained requirements while refusing different immutable bytes under one name. */
export function mergeAssetManifests(inputs: readonly unknown[]): AssetManifest {
  const entries = new Map<string, AssetManifestEntry>();
  for (const input of inputs)
    for (const entry of parseAssetManifest(input).entries) {
      const previous = entries.get(entry.name);
      if (
        previous &&
        (previous.byteLength !== entry.byteLength || previous.sha256 !== entry.sha256)
      )
        throw new AssetManifestError(`Conflicting asset bytes under one name: ${entry.name}`);
      entries.set(entry.name, entry);
    }
  return manifest([...entries.values()]);
}
