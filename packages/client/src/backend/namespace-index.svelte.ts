import { BackendError } from "./contract.js";
import type { KozaneBackend, NamespaceGetResult } from "./contract.js";
import { readNamespaceList } from "./decoders/namespaces.js";
import { NAME_MAX } from "../constants/index.js";

export type NamespaceRow = NamespaceGetResult;
type NamespaceBackend = Pick<
  KozaneBackend,
  "version" | "state" | "subscribe" | "subscribeState" | "namespaces"
>;

function rows(value: unknown): NamespaceRow[] {
  const result = readNamespaceList(value);
  if (!result) throw new BackendError("unavailable", "Invalid namespace list");
  return result;
}

/** Keep the namespace index visible while committed changes are re-read. */
export class NamespaceIndex {
  namespaces = $state.raw<NamespaceRow[]>([]);
  submitting = $state(false);
  current = $state(false);
  #generation: number;
  #creation = 0;
  error = $state<string | null>(null);
  refreshError = $state<string | null>(null);
  #active = false;
  #running = false;
  #dirty = true;
  #sequence = 0;

  constructor(
    private readonly backend: NamespaceBackend,
    initial: NamespaceRow[],
  ) {
    this.namespaces = initial;
    this.#generation = backend.version.generation;
    this.current = backend.state.status === "ready";
  }

  start(options: { retryIntervalMs?: number | false } = {}): () => void {
    if (this.#active) throw new Error("Namespace index is already active");
    this.#active = true;
    this.#dirty = true;
    const unsubscribe = this.backend.subscribe((event) => {
      const replaced = event.generation !== this.#generation;
      if (replaced) {
        this.#generation = event.generation;
        this.current = false;
        this.#creation++;
        this.submitting = false;
        this.error = null;
        this.refreshError = null;
      }
      if (replaced || event.datasets.includes("namespaces")) this.#invalidate();
    });
    const unsubscribeState = this.backend.subscribeState((state) => {
      if (state.status !== "ready") {
        this.current = false;
        this.#sequence++;
        this.#dirty = true;
      } else void this.#refresh();
    });
    const timer =
      options.retryIntervalMs === false
        ? undefined
        : setInterval(() => {
            void this.#refresh();
          }, options.retryIntervalMs ?? 1000);
    void this.#refresh();
    return () => {
      this.#active = false;
      this.#sequence++;
      if (timer !== undefined) clearInterval(timer);
      unsubscribe();
      unsubscribeState();
    };
  }

  async create(name: string): Promise<boolean> {
    if (this.submitting || !this.current || this.backend.state.status !== "ready") return false;
    const creation = ++this.#creation;
    const generation = this.backend.version.generation;
    this.submitting = true;
    this.error = null;
    try {
      await this.backend.namespaces.create({ name: name.trim() });
      return (
        creation === this.#creation &&
        generation === this.backend.version.generation &&
        this.current &&
        this.backend.state.status === "ready"
      );
    } catch (error) {
      if (
        creation !== this.#creation ||
        generation !== this.backend.version.generation ||
        this.backend.state.status !== "ready"
      )
        return false;
      const compatible: Record<string, string> = {
        "name is required": "Namespace name is required.",
        [`name must be ${NAME_MAX} characters or fewer`]: `Namespace name must be ${NAME_MAX} characters or fewer.`,
      };
      this.error =
        error instanceof BackendError
          ? (compatible[error.message] ?? error.message)
          : "Failed to create namespace";
      return false;
    } finally {
      if (creation === this.#creation) this.submitting = false;
    }
  }

  #invalidate() {
    this.#sequence++;
    this.#dirty = true;
    void this.#refresh();
  }

  async #refresh(): Promise<void> {
    if (!this.#active || this.#running || !this.#dirty || this.backend.state.status !== "ready")
      return;
    this.#running = true;
    this.#dirty = false;
    const sequence = this.#sequence;
    const generation = this.backend.version.generation;
    try {
      const result = rows(await this.backend.namespaces.list());
      if (!this.#active) return;
      if (
        sequence !== this.#sequence ||
        generation !== this.backend.version.generation ||
        this.backend.state.status !== "ready"
      ) {
        this.#dirty = true;
        return;
      }
      this.namespaces = result;
      this.#generation = generation;
      this.current = true;
      this.refreshError = null;
    } catch {
      if (this.#active) {
        this.#dirty = true;
        if (
          sequence === this.#sequence &&
          generation === this.backend.version.generation &&
          this.backend.state.status === "ready"
        )
          this.refreshError = "Could not refresh namespaces";
      }
    } finally {
      this.#running = false;
      // An invalidation during this read must not depend on a retry timer.
      if (this.#dirty && sequence !== this.#sequence) void this.#refresh();
    }
  }
}
