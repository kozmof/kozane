import type { SnapshotData, SnapshotResult } from "./contract.js";

interface Binding {
  namespaceId: string;
  generation: number;
  signature: string;
}
/** Bookkeeping only. Call after a consistent successful read, including namespace validation. */
export class SnapshotValidators {
  private readonly instance = crypto.randomUUID();
  private sequence = 0;
  private readonly bindings = new Map<string, Binding>();
  constructor(private readonly capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Validator capacity must be positive");
  }
  result(
    namespaceId: string,
    generation: number,
    signature: string,
    data: SnapshotData,
    validator?: string,
  ): SnapshotResult {
    const previous = validator ? this.bindings.get(validator) : undefined;
    if (
      previous &&
      previous.namespaceId === namespaceId &&
      previous.generation === generation &&
      previous.signature === signature
    )
      return { status: "unchanged", validator: validator! };
    const next = `${this.instance}:${++this.sequence}`;
    this.bindings.set(next, { namespaceId, generation, signature });
    while (this.bindings.size > this.capacity)
      this.bindings.delete(this.bindings.keys().next().value!);
    return { status: "changed", validator: next, data };
  }
  signature(namespaceId: string, generation: number, validator?: string): string | undefined {
    const binding = validator ? this.bindings.get(validator) : undefined;
    return binding?.namespaceId === namespaceId && binding.generation === generation
      ? binding.signature
      : undefined;
  }
  clear(): void {
    this.bindings.clear();
  }
}
