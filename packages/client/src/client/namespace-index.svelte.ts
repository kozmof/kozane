import { ClientError } from "./contract.js";
import type { NamespaceGetResult } from "./contract.js";
import type { NamespacesViewClient } from "./view-clients.js";
import { readNamespaceList } from "./decoders/namespaces.js";
import { NAME_MAX } from "../constants/index.js";

export type NamespaceRow = NamespaceGetResult;
type NamespaceClient = Omit<NamespacesViewClient, "capabilities">;

function rows(value: unknown): NamespaceRow[] {
  const result = readNamespaceList(value);
  if (!result) throw new ClientError("unavailable", "Invalid namespace list");
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
  #pending?: AbortController;
  #running = false;
  #dirty = true;
  #sequence = 0;

  constructor(
    private readonly client: NamespaceClient,
    initial: NamespaceRow[],
  ) {
    this.namespaces = initial;
    this.#generation = client.version.generation;
    this.current = client.state.status === "ready";
  }

  start(options: { retryIntervalMs?: number | false } = {}): () => void {
    if (this.#active) throw new Error("Namespace index is already active");
    this.#active = true;
    this.#dirty = true;
    const unsubscribe = this.client.subscribe((event) => {
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
    const unsubscribeState = this.client.subscribeState((state) => {
      if (state.status !== "ready") {
        this.current = false;
        this.#sequence++;
        this.#pending?.abort();
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
      this.current = false;
      this.submitting = false;
      this.#creation++;
      this.#sequence++;
      this.#pending?.abort();
      if (timer !== undefined) clearInterval(timer);
      unsubscribe();
      unsubscribeState();
    };
  }

  async create(name: string): Promise<boolean> {
    if (this.submitting || !this.current || this.client.state.status !== "ready") return false;
    const creation = ++this.#creation;
    const generation = this.client.version.generation;
    this.submitting = true;
    this.error = null;
    try {
      await this.client.namespaces.create({ name: name.trim() });
      return (
        creation === this.#creation &&
        generation === this.client.version.generation &&
        this.current &&
        this.client.state.status === "ready"
      );
    } catch (error) {
      if (
        creation !== this.#creation ||
        generation !== this.client.version.generation ||
        this.client.state.status !== "ready"
      )
        return false;
      const compatible: Record<string, string> = {
        "name is required": "Namespace name is required.",
        [`name must be ${NAME_MAX} characters or fewer`]: `Namespace name must be ${NAME_MAX} characters or fewer.`,
      };
      this.error =
        error instanceof ClientError
          ? (compatible[error.message] ?? error.message)
          : "Failed to create namespace";
      return false;
    } finally {
      if (creation === this.#creation) this.submitting = false;
    }
  }

  #invalidate() {
    this.#sequence++;
    this.#pending?.abort();
    this.#dirty = true;
    void this.#refresh();
  }

  async #refresh(): Promise<void> {
    if (!this.#active || this.#running || !this.#dirty || this.client.state.status !== "ready")
      return;
    this.#running = true;
    this.#dirty = false;
    const controller = new AbortController();
    this.#pending = controller;
    const sequence = this.#sequence;
    const generation = this.client.version.generation;
    try {
      const result = rows(await this.client.namespaces.list({ signal: controller.signal }));
      if (!this.#active || controller.signal.aborted) return;
      if (
        sequence !== this.#sequence ||
        generation !== this.client.version.generation ||
        this.client.state.status !== "ready"
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
          generation === this.client.version.generation &&
          this.client.state.status === "ready"
        )
          this.refreshError = "Could not refresh namespaces";
      }
    } finally {
      if (this.#pending === controller) this.#pending = undefined;
      this.#running = false;
      // An invalidation during this read must not depend on a retry timer.
      if (this.#dirty && sequence !== this.#sequence) void this.#refresh();
    }
  }
}
