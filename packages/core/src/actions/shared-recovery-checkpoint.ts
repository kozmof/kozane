/** Canonical binding for the shared row history of one originating recovery checkpoint. */
import type { DB } from "../database.js";
import { migrations } from "../generated/migrations.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  SharedRecoveryError,
  prepareSharedRecoveryHistory,
  parseSharedRecoverySelection,
  validateSharedRecoveryProjection,
  type SharedRecoveryHistory,
  type SharedRecoverySelection,
} from "./shared-recovery.js";

export const SHARED_RECOVERY_HISTORY_VERSION = 1;
export const SHARED_RECOVERY_CHECKPOINT_VERSION = 1;
export interface SharedRecoveryHistoryPayload {
  readonly version: typeof SHARED_RECOVERY_HISTORY_VERSION;
  readonly identity: LocalRecoveryIdentity;
  readonly selection: SharedRecoverySelection;
  readonly history: SharedRecoveryHistory;
}
export interface SharedRecoveryCheckpoint {
  readonly version: typeof SHARED_RECOVERY_CHECKPOINT_VERSION;
  readonly identity: LocalRecoveryIdentity;
  readonly selection: SharedRecoverySelection;
  readonly byteLength: number;
  readonly sha256: string;
}
function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new SharedRecoveryError("Invalid shared recovery checkpoint data");
  return Object.fromEntries(
    names.map((name) => {
      const field = Object.getOwnPropertyDescriptor(input, name);
      if (!field || !("value" in field) || !field.enumerable)
        throw new SharedRecoveryError("Shared recovery checkpoint requires plain data fields");
      return [name, field.value];
    }),
  );
}

/** Known historical descriptors are metadata. Actual shared history loading requires the bundled schema. */
export function parseSharedRecoveryCheckpoint(input: unknown): SharedRecoveryCheckpoint {
  const value = fields(input, ["version", "identity", "selection", "byteLength", "sha256"]);
  if (
    value.version !== SHARED_RECOVERY_CHECKPOINT_VERSION ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed shared recovery checkpoint");
  return Object.freeze({
    version: SHARED_RECOVERY_CHECKPOINT_VERSION,
    identity: parseLocalRecoveryIdentity(
      value.identity,
      migrations.map(({ id }) => id),
    ),
    selection: parseSharedRecoverySelection(value.selection),
    byteLength: value.byteLength as number,
    sha256: value.sha256,
  });
}
function preparePayload(input: unknown) {
  const value = fields(input, ["version", "identity", "selection", "history"]);
  if (value.version !== SHARED_RECOVERY_HISTORY_VERSION)
    throw new SharedRecoveryError("Unsupported shared recovery history version");
  const identity = parseLocalRecoveryIdentity(value.identity);
  const selection = parseSharedRecoverySelection(value.selection);
  const prepared = prepareSharedRecoveryHistory(value.history, selection);
  if (identity.schemaId !== prepared.projection.schemaId)
    throw new SharedRecoveryError("Shared recovery history schema mismatch");
  const payload: SharedRecoveryHistoryPayload = Object.freeze({
    version: SHARED_RECOVERY_HISTORY_VERSION,
    identity,
    selection: prepared.selection,
    history: prepared.history,
  });
  return Object.freeze({ payload, projection: prepared.projection });
}

/** Canonical immutable transport inspection does not authenticate its contents. */
export function parseSharedRecoveryHistoryPayload(input: unknown): SharedRecoveryHistoryPayload {
  return preparePayload(input).payload;
}
async function describe(prepared: ReturnType<typeof preparePayload>) {
  const bytes = new TextEncoder().encode(JSON.stringify(prepared.payload));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const checkpoint = parseSharedRecoveryCheckpoint({
    version: SHARED_RECOVERY_CHECKPOINT_VERSION,
    identity: prepared.payload.identity,
    selection: prepared.payload.selection,
    byteLength: bytes.byteLength,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  });
  return Object.freeze({ ...prepared, checkpoint });
}

/** Only trusted capture should establish a descriptor for the host's completed history selection. */
export async function describeSharedRecoveryHistory(
  input: unknown,
  identity: LocalRecoveryIdentity,
  selection: SharedRecoverySelection,
) {
  return describe(
    preparePayload({
      version: SHARED_RECOVERY_HISTORY_VERSION,
      identity,
      selection,
      history: input,
    }),
  );
}

/** Copy the separately retained expectation and host identity before hashing any received transport. */
export async function requireSharedRecoveryCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
) {
  const wanted = parseSharedRecoveryCheckpoint(checkpoint);
  const identity = parseLocalRecoveryIdentity(expected);
  const prepared = preparePayload(input);
  if (
    JSON.stringify(prepared.payload.identity) !== JSON.stringify(identity) ||
    JSON.stringify(wanted.identity) !== JSON.stringify(identity)
  )
    throw new SharedRecoveryError("Shared recovery checkpoint identity mismatch");
  if (JSON.stringify(prepared.payload.selection) !== JSON.stringify(wanted.selection))
    throw new SharedRecoveryError("Shared recovery checkpoint selection mismatch");
  const actual = (await describe(prepared)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Shared recovery checkpoint content mismatch");
  return prepared;
}

/** A matching content descriptor still needs isolated SQL constraints and exact tagged read-back. */
export async function validateSharedRecoveryCheckpoint(
  createDatabase: () => Promise<DB>,
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
) {
  const prepared = await requireSharedRecoveryCheckpoint(input, checkpoint, expected);
  const projection = await validateSharedRecoveryProjection(createDatabase, prepared.projection);
  return Object.freeze({ payload: prepared.payload, projection });
}
