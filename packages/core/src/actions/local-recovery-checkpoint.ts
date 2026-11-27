/** Canonical content binding for a local checkpoint. Descriptors are not activation receipts. */
import type { DB, ReadTx } from "../database.js";
import { migrations } from "../generated/migrations.js";
import {
  LocalRecoveryError,
  captureLocalRecoverySnapshot,
  parseLocalRecoveryIdentity,
  parseLocalRecoverySelection,
  parseLocalRecoverySnapshot,
  type LocalRecoveryIdentity,
  type LocalRecoverySelection,
  type LocalRecoverySnapshot,
} from "./local-recovery.js";

export const LOCAL_RECOVERY_CHECKPOINT_VERSION = 1;
export interface LocalRecoveryCheckpoint {
  readonly version: typeof LOCAL_RECOVERY_CHECKPOINT_VERSION;
  readonly identity: LocalRecoveryIdentity;
  readonly selection: LocalRecoverySelection;
  readonly byteLength: number;
  readonly sha256: string;
}
export type LocalRecoveryCheckpointKey = Pick<
  LocalRecoveryIdentity,
  "workspaceId" | "deviceId" | "epochId" | "checkpointId"
>;
const keyFields = ["workspaceId", "deviceId", "epochId", "checkpointId"] as const;
function fields(input: unknown, names: readonly string[]) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new LocalRecoveryError("Invalid local recovery checkpoint data");
  return Object.fromEntries(
    names.map((name) => {
      const value = Object.getOwnPropertyDescriptor(input, name);
      if (!value || !("value" in value) || !value.enumerable)
        throw new LocalRecoveryError("Local recovery checkpoint requires plain fields");
      return [name, value.value];
    }),
  );
}
export function parseLocalRecoveryCheckpointKey(input: unknown): LocalRecoveryCheckpointKey {
  const value = fields(input, keyFields);
  const parsed = parseLocalRecoveryIdentity({ ...value, schemaId: migrations.at(-1)!.id });
  return Object.freeze({
    workspaceId: parsed.workspaceId,
    deviceId: parsed.deviceId,
    epochId: parsed.epochId,
    checkpointId: parsed.checkpointId,
  });
}

/** Known historical descriptors can be retained as metadata. Snapshot loading still requires the current schema. */
export function parseLocalRecoveryCheckpointRecord(
  key: unknown,
  descriptor: unknown,
): LocalRecoveryCheckpoint {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new LocalRecoveryError("Stored checkpoint descriptor requires TEXT");
  const parsed = parseLocalRecoveryCheckpoint(JSON.parse(descriptor));
  if (keyFields.some((field) => wanted[field] !== parsed.identity[field]))
    throw new LocalRecoveryError("Stored checkpoint identity mismatch");
  return parsed;
}

/** Finish the consistent read boundary before hashing its immutable result. */
export async function captureLocalRecoveryCheckpoint(
  db: DB,
  identity: LocalRecoveryIdentity,
  readSelection: (tx: ReadTx) => Promise<LocalRecoverySelection>,
) {
  return describe(await captureLocalRecoverySnapshot(db, identity, readSelection));
}

/** Validate transport without invoking accessors or serialization hooks. */
export function parseLocalRecoveryCheckpoint(input: unknown): LocalRecoveryCheckpoint {
  const fields = ["version", "identity", "selection", "byteLength", "sha256"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== fields.length
  )
    throw new LocalRecoveryError("Invalid local recovery checkpoint");
  const data = Object.fromEntries(
    fields.map((field) => {
      const property = Object.getOwnPropertyDescriptor(input, field);
      if (!property || !("value" in property) || !property.enumerable)
        throw new LocalRecoveryError("Local recovery checkpoint requires plain fields");
      return [field, property.value];
    }),
  );
  if (
    data.version !== LOCAL_RECOVERY_CHECKPOINT_VERSION ||
    !Number.isSafeInteger(data.byteLength) ||
    data.byteLength < 1 ||
    typeof data.sha256 !== "string" ||
    data.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(data.sha256)
  )
    throw new LocalRecoveryError("Unsupported or malformed local recovery checkpoint");
  return Object.freeze({
    version: LOCAL_RECOVERY_CHECKPOINT_VERSION,
    identity: parseLocalRecoveryIdentity(
      data.identity,
      migrations.map((row) => row.id),
    ),
    selection: parseLocalRecoverySelection(data.selection),
    byteLength: data.byteLength,
    sha256: data.sha256,
  });
}

/** Hash owned canonical UTF-8 bytes outside database transactions. Input JSON formatting is irrelevant. */
export async function describeLocalRecoverySnapshot(input: unknown) {
  return describe(parseLocalRecoverySnapshot(input));
}
async function describe(snapshot: LocalRecoverySnapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const checkpoint = parseLocalRecoveryCheckpoint({
    version: LOCAL_RECOVERY_CHECKPOINT_VERSION,
    identity: snapshot.identity,
    selection: snapshot.selection,
    byteLength: bytes.byteLength,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  });
  return Object.freeze({ snapshot, checkpoint });
}

/** A trusted host must retain the expected descriptor separately from the received snapshot. */
export async function requireLocalRecoveryCheckpoint(input: unknown, expected: unknown) {
  const wanted = parseLocalRecoveryCheckpoint(expected);
  const snapshot = parseLocalRecoverySnapshot(input);
  if (JSON.stringify(snapshot.identity) !== JSON.stringify(wanted.identity))
    throw new LocalRecoveryError("Local recovery checkpoint identity mismatch");
  if (JSON.stringify(snapshot.selection) !== JSON.stringify(wanted.selection))
    throw new LocalRecoveryError("Local recovery checkpoint selection mismatch");
  const { checkpoint } = await describe(snapshot);
  if (checkpoint.byteLength !== wanted.byteLength || checkpoint.sha256 !== wanted.sha256)
    throw new LocalRecoveryError("Local recovery checkpoint content mismatch");
  return snapshot;
}
