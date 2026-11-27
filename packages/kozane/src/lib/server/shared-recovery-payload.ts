/** Persist the original registered shared row-history payload without claiming complete bundle publication. */
import { sql } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { withTx, type DB, type Tx } from "../../db/database.js";
import {
  parseLocalRecoveryIdentity,
  parseSharedRecoveryHistoryPayload,
  requireSharedRecoveryCheckpoint,
  inspectSharedRecoveryCheckpoint,
  readSharedRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  validateStoredSharedRecoveryCheckpoint,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpointKey,
  type SharedRecoveryCheckpointBinding,
} from "@kozane/core/recovery";
import {
  observe,
  publishRecoveryPayload,
  directory,
  paths,
  readEntry,
  sameFile,
} from "./recovery-payload-files.js";

export class SharedRecoveryPayloadError extends Error {
  override readonly name = "SharedRecoveryPayloadError";
}
const area = "shared-history";
async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new SharedRecoveryPayloadError("Temporary checkpoint payload needs review");
}
async function requireBinding(tx: Tx, binding: SharedRecoveryCheckpointBinding) {
  const { workspaceId, deviceId, epochId, checkpointId } = binding.checkpoint.identity;
  const key = { workspaceId, deviceId, epochId, checkpointId };
  const current = await readSharedRecoveryCheckpoint(tx, key);
  const local = await readLocalRecoveryCheckpoint(tx, key);
  if (
    !current ||
    JSON.stringify(current) !== JSON.stringify(binding) ||
    !local ||
    JSON.stringify(local) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryPayloadError(
      "Trusted shared or local checkpoint binding changed before payload publication",
    );
}

/** Inspection observes bytes and metadata, including orphaned bindings, without authorizing a write. */
export async function inspectRegisteredSharedRecoveryPayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const binding = await inspectSharedRecoveryCheckpoint(db, key);
  if (!binding) throw new SharedRecoveryPayloadError("Trusted shared checkpoint is not registered");
  return { binding, ...(await observe(root, binding.checkpoint, area)) };
}

/** Validate both trusted catalog bindings before disk work. Never replace files or automatically retry. */
export async function saveRegisteredSharedRecoveryPayload(options: {
  root: string;
  db: DB;
  input: unknown;
  expected: LocalRecoveryIdentity;
  createValidationDatabase: () => Promise<DB>;
}) {
  const { root, db, createValidationDatabase } = options;
  const expected = parseLocalRecoveryIdentity(options.expected);
  const input = parseSharedRecoveryHistoryPayload(options.input);
  const { workspaceId, deviceId, epochId, checkpointId } = expected;
  const binding = await inspectSharedRecoveryCheckpoint(db, {
    workspaceId,
    deviceId,
    epochId,
    checkpointId,
  });
  if (!binding) throw new SharedRecoveryPayloadError("Trusted shared checkpoint is not registered");
  const validated = await validateStoredSharedRecoveryCheckpoint(
    db,
    createValidationDatabase,
    input,
    expected,
  );
  // Bind the bytes to the original pair read above, even if a different pair was observed during validation.
  await requireSharedRecoveryCheckpoint(validated.payload, binding.checkpoint, expected);
  const bytes = Buffer.from(JSON.stringify(validated.payload), "utf8");
  return withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_shared_history SET descriptor=descriptor WHERE 0`);
    const published = await publishRecoveryPayload(
      root,
      area,
      binding.checkpoint,
      bytes,
      () => requireBinding(tx, binding),
      SharedRecoveryPayloadError,
    );
    return { path: published.path, binding, changed: published.changed };
  });
}

/** Load only published bytes within the host's explicit size limit. Never consume temporary evidence. */
export async function loadRegisteredSharedRecoveryPayload(options: {
  root: string;
  db: DB;
  expected: LocalRecoveryIdentity;
  maxBytes: number;
  createValidationDatabase: () => Promise<DB>;
}) {
  const { root, db, maxBytes, createValidationDatabase } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new SharedRecoveryPayloadError("Payload read limit must be a positive safe integer");
  const expected = parseLocalRecoveryIdentity(options.expected);
  const { workspaceId, deviceId, epochId, checkpointId } = expected;
  const binding = await inspectSharedRecoveryCheckpoint(db, {
    workspaceId,
    deviceId,
    epochId,
    checkpointId,
  });
  if (!binding) throw new SharedRecoveryPayloadError("Trusted shared checkpoint is not registered");
  if (JSON.stringify(binding.checkpoint.identity) !== JSON.stringify(expected))
    throw new SharedRecoveryPayloadError("Registered checkpoint identity mismatch");
  if (binding.checkpoint.byteLength > maxBytes)
    throw new SharedRecoveryPayloadError("Registered payload exceeds read limit");
  const loaded = await withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_shared_history SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, binding);
    const files = paths(await directory(root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, binding.checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new SharedRecoveryPayloadError(`Registered checkpoint payload is ${file.evidence}`);
    await requireNoTemporary(files.temporary);
    return { bytes: file.content, identity: file.identity };
  });
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes),
    );
  } catch (cause) {
    throw new SharedRecoveryPayloadError("Registered checkpoint payload is not valid UTF-8 JSON", {
      cause,
    });
  }
  const validated = await validateStoredSharedRecoveryCheckpoint(
    db,
    createValidationDatabase,
    input,
    expected,
  );
  await withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_shared_history SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, binding);
    const files = paths(await directory(root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new SharedRecoveryPayloadError(
        "Registered checkpoint payload changed during validation",
      );
  });
  return Object.freeze({ payload: validated.payload, projection: validated.projection, binding });
}
