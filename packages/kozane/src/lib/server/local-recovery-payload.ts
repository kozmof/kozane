/** Immutable local snapshot files. Catalog registration is required before filesystem publication. */
import * as fs from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  directory,
  paths,
  observe,
  readEntry,
  sameFile,
  publishRecoveryPayload,
} from "./recovery-payload-files.js";
import { withTx, type DB, type Tx } from "../../db/database.js";
import {
  describeLocalRecoverySnapshot,
  inspectLocalRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  validateStoredLocalRecoveryCheckpoint,
  parseLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpoint,
  type LocalRecoveryCheckpointKey,
  type LocalRecoverySnapshot,
} from "@kozane/core/recovery";

export class LocalRecoveryPayloadError extends Error {
  override readonly name = "LocalRecoveryPayloadError";
}
const code = (error: unknown) => (error instanceof Error && "code" in error ? error.code : null);
export type { RecoveryPayloadEvidence as LocalRecoveryPayloadEvidence } from "./recovery-payload-files.js";
/** Read-only inspection. Matching temporary data does not authorize publication or cleanup. */
export async function inspectRegisteredLocalRecoveryPayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const checkpoint = await inspectLocalRecoveryCheckpoint(db, key);
  if (!checkpoint) throw new LocalRecoveryPayloadError("Trusted checkpoint is not registered");
  return { checkpoint, ...(await observe(root, checkpoint)) };
}
async function requireBinding(tx: Tx, expected: LocalRecoveryCheckpoint) {
  const { workspaceId, deviceId, epochId, checkpointId } = expected.identity;
  const current = await readLocalRecoveryCheckpoint(tx, {
    workspaceId,
    deviceId,
    epochId,
    checkpointId,
  });
  if (!current || JSON.stringify(current) !== JSON.stringify(expected))
    throw new LocalRecoveryPayloadError(
      "Trusted checkpoint binding changed before payload publication",
    );
}

async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  throw new LocalRecoveryPayloadError("Temporary checkpoint payload needs review");
}

/** Read a published checkpoint without installing rows, following links or consuming temporary data. */
export async function loadRegisteredLocalRecoveryPayload(options: {
  root: string;
  db: DB;
  expected: LocalRecoveryIdentity;
  maxBytes: number;
  createValidationDatabase: () => Promise<DB>;
}): Promise<Readonly<{ snapshot: LocalRecoverySnapshot; checkpoint: LocalRecoveryCheckpoint }>> {
  const { root, db, maxBytes, createValidationDatabase } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new LocalRecoveryPayloadError("Payload read limit must be a positive safe integer");
  const expected = parseLocalRecoveryIdentity(options.expected);
  const { workspaceId, deviceId, epochId, checkpointId } = expected;
  const checkpoint = await inspectLocalRecoveryCheckpoint(db, {
    workspaceId,
    deviceId,
    epochId,
    checkpointId,
  });
  if (!checkpoint) throw new LocalRecoveryPayloadError("Trusted checkpoint is not registered");
  if (JSON.stringify(checkpoint.identity) !== JSON.stringify(expected))
    throw new LocalRecoveryPayloadError("Registered checkpoint identity mismatch");
  if (checkpoint.byteLength > maxBytes)
    throw new LocalRecoveryPayloadError("Registered payload exceeds read limit");
  const loaded = await withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, checkpoint);
    const files = paths(await directory(root, false), checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new LocalRecoveryPayloadError(`Registered checkpoint payload is ${file.evidence}`);
    await requireNoTemporary(files.temporary);
    return { bytes: file.content, identity: file.identity };
  });
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes),
    );
  } catch (cause) {
    throw new LocalRecoveryPayloadError("Registered checkpoint payload is not valid UTF-8 JSON", {
      cause,
    });
  }
  const snapshot = await validateStoredLocalRecoveryCheckpoint(
    db,
    createValidationDatabase,
    input,
    expected,
  );
  await withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, checkpoint);
    const files = paths(await directory(root, false), checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new LocalRecoveryPayloadError(
        "Registered checkpoint payload changed during validation",
      );
  });
  return Object.freeze({ snapshot, checkpoint });
}

/** Explicit publication of the original registered payload. Never retry callbacks or replace evidence. */
export async function saveRegisteredLocalRecoveryPayload(options: {
  root: string;
  db: DB;
  input: unknown;
  expected: LocalRecoveryIdentity;
  createValidationDatabase: () => Promise<DB>;
}) {
  const { root, db, input, expected, createValidationDatabase } = options;
  const validated = await validateStoredLocalRecoveryCheckpoint(
    db,
    createValidationDatabase,
    input,
    expected,
  );
  const { snapshot, checkpoint } = await describeLocalRecoverySnapshot(validated);
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  return withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=descriptor WHERE 0`);
    const published = await publishRecoveryPayload(
      root,
      "checkpoints",
      checkpoint,
      bytes,
      () => requireBinding(tx, checkpoint),
      LocalRecoveryPayloadError,
    );
    return { path: published.path, checkpoint, changed: published.changed };
  });
}
