import {
  failureKind,
  HarnessFailure,
  RECOVERY_KEY,
  type Candidate,
  type StorageAccess,
} from "./recovery";
export interface ResetState<View> {
  readonly generation: number;
  readonly candidate: Candidate<View>;
  readonly view: View;
  readonly namespaceId: string;
  readonly url: string;
}
export interface ResetOptions<View> {
  sample(): Promise<{ bytes: Uint8Array; namespaceId: string }>;
  /** Stage an independent candidate. Opening it must preserve the current live handle. */
  open(bytes: Uint8Array): Promise<Candidate<View>>;
  storage(): StorageAccess;
  destination(namespaceId: string): string;
  /** Apply the validated destination synchronously inside the reset barrier. */
  navigate?(url: string): void;
}
export type ResetResult<View> =
  | {
      status: "ready";
      state: ResetState<View>;
      recoveryUnavailable: boolean;
      olderCopyMayRestore: boolean;
      previousCleanupFailed: boolean;
    }
  | {
      status: "unavailable";
      action: "retry" | "reload";
      kind: "database_content" | "asset" | "transient" | "unknown";
    };
/** The supplied whole-operation queue also serializes edits, reads and export against reset. */
export class ResetSession<View> {
  private current: ResetState<View>;
  private reloadKind: "database_content" | "asset" | undefined;
  constructor(
    initial: ResetState<View>,
    private readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {
    this.current = Object.freeze({ ...initial });
  }
  get state(): ResetState<View> {
    return this.current;
  }
  reset(options: ResetOptions<View>): Promise<ResetResult<View>> {
    return this.serialize(async () => {
      if (this.reloadKind)
        return { status: "unavailable", action: "reload", kind: this.reloadKind };
      let staged: Candidate<View> | undefined;
      let view: View, namespaceId: string, url: string;
      try {
        const sample = await options.sample();
        namespaceId = sample.namespaceId;
        staged = await options.open(sample.bytes);
        view = await staged.validate({ namespaceId, sampleNamespaceId: namespaceId });
        url = options.destination(namespaceId);
        options.navigate?.(url);
      } catch (error) {
        let failure = error;
        if (staged) {
          try {
            await staged.close();
          } catch {
            failure = new HarnessFailure("unknown", "Candidate cleanup failed");
          }
        }
        const kind = failureKind(failure);
        if (kind === "database_content" || kind === "asset") this.reloadKind = kind;
        return { status: "unavailable", action: this.reloadKind ? "reload" : "retry", kind };
      }
      // Validation and destination calculation have completed before this synchronous activation.
      const previous = this.current;
      this.current = Object.freeze({
        generation: previous.generation + 1,
        candidate: staged,
        view,
        namespaceId,
        url,
      });
      let recoveryUnavailable = false,
        olderCopyMayRestore = false,
        previousCleanupFailed = false;
      try {
        options.storage().removeItem(RECOVERY_KEY);
      } catch {
        recoveryUnavailable = true;
        olderCopyMayRestore = true;
      }
      try {
        await previous.candidate.close();
      } catch {
        previousCleanupFailed = true;
      }
      return {
        status: "ready",
        state: this.current,
        recoveryUnavailable,
        olderCopyMayRestore,
        previousCleanupFailed,
      };
    });
  }
}
