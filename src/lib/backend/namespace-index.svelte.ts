import { BackendError } from "./contract.js";
import type { HttpBackend } from "./http-backend.js";
import { NAME_MAX } from "../constants.js";

export type NamespaceRow = { id: string; name: string; isDefault: boolean };
type NamespaceBackend = Pick<
  HttpBackend,
  "version" | "state" | "subscribe" | "subscribeState" | "namespaces"
>;

function rows(value: unknown): NamespaceRow[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        typeof row.isDefault !== "boolean",
    )
  )
    throw new BackendError("unavailable", "Invalid namespace list");
  return value;
}

/** Keep the namespace index visible while committed changes are re-read. */
export class NamespaceIndex {
  namespaces = $state.raw<NamespaceRow[]>([]);
  submitting = $state(false);
  error = $state<string | null>(null);
  #active = false;
  #running = false;
  #dirty = true;
  #sequence = 0;

  constructor(
    private readonly backend: NamespaceBackend,
    initial: NamespaceRow[],
  ) {
    this.namespaces = initial;
  }

  start(): () => void {
    if (this.#active) throw new Error("Namespace index is already active");
    this.#active = true;
    this.#dirty = true;
    const unsubscribe = this.backend.subscribe((event) => {
      if (event.datasets.includes("namespaces")) this.#invalidate();
    });
    const unsubscribeState = this.backend.subscribeState((state) => {
      if (state.status !== "ready") {
        this.#sequence++;
        this.#dirty = true;
      } else void this.#refresh();
    });
    const timer = setInterval(() => {
      void this.#refresh();
    }, 1000);
    void this.#refresh();
    return () => {
      this.#active = false;
      this.#sequence++;
      clearInterval(timer);
      unsubscribe();
      unsubscribeState();
    };
  }

  async create(name: string): Promise<boolean> {
    if (this.submitting) return false;
    this.submitting = true;
    this.error = null;
    try {
      await this.backend.namespaces.create({ name: name.trim() });
      return true;
    } catch (error) {
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
      this.submitting = false;
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
    } catch {
      if (this.#active) this.#dirty = true;
    } finally {
      this.#running = false;
    }
  }
}
