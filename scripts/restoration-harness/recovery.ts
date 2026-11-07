import { SupersededAttemptError, type AttemptLease } from "./attempt";
import type { DestinationTracker } from "./navigation";
export const RECOVERY_KEY = "kozane-demo:session";
export const RECOVERY_DB_MAX_BYTES = 2_097_152;
export const RECOVERY_ENVELOPE_MAX_CHARS = 3_145_728;
export type FailureKind = "database_content" | "asset" | "transient" | "unknown";
export class HarnessFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}
export class RecoveryCopyError extends Error {
  constructor(readonly reason: "malformed" | "size" | "incompatible") {
    super(`Recovery copy is ${reason}`);
  }
}
export interface RecoveryEnvelope {
  readonly schemaVersion: string;
  readonly savedAt: number;
  readonly bytes: Uint8Array;
}
/** Bound allocation before decoding and require exact padded base64, including unused pad bits. */
export function decodeRecovery(text: string, schemaVersion: string): RecoveryEnvelope {
  if (text.length > RECOVERY_ENVELOPE_MAX_CHARS) throw new RecoveryCopyError("size");
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new RecoveryCopyError("malformed");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new RecoveryCopyError("malformed");
  const value = envelope as Record<string, unknown>;
  if (
    !["schemaVersion", "savedAt", "db"].every((key) => Object.hasOwn(value, key)) ||
    typeof value.schemaVersion !== "string" ||
    value.schemaVersion.length === 0 ||
    typeof value.savedAt !== "number" ||
    !Number.isSafeInteger(value.savedAt) ||
    value.savedAt < 0 ||
    value.savedAt > 8_640_000_000_000_000 ||
    typeof value.db !== "string" ||
    value.db.length === 0
  )
    throw new RecoveryCopyError("malformed");
  if (value.db.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.db))
    throw new RecoveryCopyError("malformed");
  const padding = value.db.endsWith("==") ? 2 : value.db.endsWith("=") ? 1 : 0;
  const length = (value.db.length / 4) * 3 - padding;
  if (length > RECOVERY_DB_MAX_BYTES) throw new RecoveryCopyError("size");
  // Padding bits must be zero. This rejects alternate encodings before allocating bytes.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (padding === 2 && (alphabet.indexOf(value.db.at(-3)!) & 15) !== 0) ||
    (padding === 1 && (alphabet.indexOf(value.db.at(-2)!) & 3) !== 0)
  )
    throw new RecoveryCopyError("malformed");
  if (value.schemaVersion !== schemaVersion) throw new RecoveryCopyError("incompatible");
  const binary = atob(value.db);
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    savedAt: value.savedAt,
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  });
}
export interface CandidateRequest {
  namespaceId?: string;
  sampleNamespaceId?: string;
  navigation?: DestinationTracker;
  beforeView?: (namespaceId?: string) => Promise<void>;
}
export interface Candidate<View> {
  validate(request: CandidateRequest): Promise<View>;
  close(): Promise<void>;
}
export interface StorageAccess {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}
export interface RestoreOptions<View> {
  schemaVersion: string;
  attempt?: AttemptLease;
  publication?: { ready(): Promise<void>; isReady(): boolean };
  namespaceId?: string;
  navigation?: DestinationTracker;
  beforeView?: (namespaceId?: string) => Promise<void>;
  storage(): StorageAccess;
  sample(): Promise<{ bytes: Uint8Array; namespaceId: string }>;
  open(bytes: Uint8Array): Promise<Candidate<View>>;
}
export type RestoreResult<View> =
  | {
      status: "ready";
      source: "sample" | "restored";
      view: View;
      candidate: Candidate<View>;
      recoveryUnavailable: boolean;
      olderCopyMayRestore: boolean;
      fallbackReason?: string;
    }
  | { status: "unavailable"; action: "retry" | "reload"; kind: FailureKind }
  | { status: "superseded" };
export function failureKind(error: unknown): FailureKind {
  const seen = new Set<unknown>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof HarnessFailure) return cause.kind;
    cause = cause.cause;
  }
  return "unknown";
}
async function validate<View, Result>(
  options: RestoreOptions<View>,
  bytes: Uint8Array,
  sampleNamespaceId: string | undefined,
  commit: (view: View, candidate: Candidate<View>) => Result,
) {
  options.attempt?.assertCurrent();
  const candidate = await options.open(bytes);
  try {
    options.attempt?.assertCurrent();
    let view: View;
    while (true) {
      const ticket = options.navigation?.capture();
      view = await candidate.validate({
        namespaceId: options.namespaceId,
        sampleNamespaceId,
        navigation: options.navigation,
        beforeView: options.beforeView,
      });
      await options.publication?.ready();
      options.attempt?.assertCurrent();
      if (
        (!ticket || options.navigation!.isCurrent(ticket)) &&
        (!options.publication || options.publication.isReady())
      )
        return commit(view, candidate);
    }
  } catch (error) {
    // Failed cleanup makes the candidate outcome uncertain and prohibits corruption fallback.
    try {
      await candidate.close();
    } catch {
      throw new HarnessFailure("unknown", "Candidate cleanup failed");
    }
    options.attempt?.assertCurrent();
    throw error;
  }
}
/** Startup policy. Destination checks guard readiness and saved-copy deletion. */
async function restoreCurrent<View>(options: RestoreOptions<View>): Promise<RestoreResult<View>> {
  options.attempt?.assertCurrent();
  let storage: StorageAccess | undefined,
    saved: string | null = null;
  let recoveryUnavailable = false,
    olderCopyMayRestore = false;
  try {
    storage = options.storage();
    saved = storage.getItem(RECOVERY_KEY);
  } catch {
    recoveryUnavailable = true;
  }
  let recovery: RecoveryEnvelope | undefined, fallbackReason: string | undefined;
  if (saved !== null) {
    try {
      recovery = decodeRecovery(saved, options.schemaVersion);
    } catch (error) {
      if (!(error instanceof RecoveryCopyError))
        return { status: "unavailable", action: "retry", kind: "unknown" };
      fallbackReason = error.reason;
    }
  }
  let sample: { bytes: Uint8Array; namespaceId: string };
  try {
    sample = await options.sample();
    const preflight = await validate(
      options,
      sample.bytes,
      sample.namespaceId,
      (view, candidate) => ({ view, candidate }),
    );
    try {
      await preflight.candidate.close();
    } catch {
      throw new HarnessFailure("unknown", "Candidate cleanup failed");
    }
  } catch (error) {
    options.attempt?.assertCurrent();
    const kind = failureKind(error);
    return {
      status: "unavailable",
      action: kind === "database_content" || kind === "asset" ? "reload" : "retry",
      kind,
    };
  }
  if (recovery) {
    try {
      return await validate(options, recovery.bytes, undefined, (view, candidate) => ({
        status: "ready" as const,
        source: "restored" as const,
        view,
        candidate,
        recoveryUnavailable,
        olderCopyMayRestore,
      }));
    } catch (error) {
      options.attempt?.assertCurrent();
      const kind = failureKind(error);
      if (kind !== "database_content")
        return { status: "unavailable", action: kind === "asset" ? "reload" : "retry", kind };
      fallbackReason = "database_content";
    }
  }
  try {
    return await validate(options, sample.bytes, sample.namespaceId, (view, candidate) => {
      if (saved !== null && fallbackReason && storage) {
        try {
          storage.removeItem(RECOVERY_KEY);
        } catch {
          recoveryUnavailable = true;
          olderCopyMayRestore = true;
        }
      }
      return {
        status: "ready" as const,
        source: "sample" as const,
        view,
        candidate,
        recoveryUnavailable,
        olderCopyMayRestore,
        ...(fallbackReason ? { fallbackReason } : {}),
      };
    });
  } catch (error) {
    const kind = failureKind(error);
    return {
      status: "unavailable",
      action: kind === "database_content" || kind === "asset" ? "reload" : "retry",
      kind,
    };
  }
}

/** Close any late candidate and suppress all outcomes from an obsolete attempt or generation. */
export async function restoreCandidate<View>(
  options: RestoreOptions<View>,
): Promise<RestoreResult<View>> {
  const candidates = new Set<Candidate<View>>();
  const tracked: RestoreOptions<View> = {
    ...options,
    open: async (bytes) => {
      const original = await options.open(bytes);
      let closed = false;
      const candidate: Candidate<View> = {
        validate: (request) => original.validate(request),
        close: async () => {
          if (closed) return;
          closed = true;
          candidates.delete(candidate);
          await original.close();
        },
      };
      candidates.add(candidate);
      return candidate;
    },
  };
  try {
    const result = await restoreCurrent(tracked);
    options.attempt?.assertCurrent();
    return result;
  } catch (error) {
    if (
      error instanceof SupersededAttemptError ||
      (options.attempt && !options.attempt.isCurrent())
    ) {
      for (const candidate of candidates) {
        try {
          await candidate.close();
        } catch {
          /* The host quarantines the obsolete worker. */
        }
      }
      return { status: "superseded" };
    }
    throw error;
  }
}
