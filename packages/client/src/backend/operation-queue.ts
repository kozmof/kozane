/** Serialize whole database operations, including transaction cleanup and export. */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Operation queue is disposed"));
    const result = this.tail.then(() => {
      if (this.disposed) throw new Error("Operation queue is disposed");
      return operation();
    });
    // A rejected operation must finish cleanup before the next operation starts,
    // but must not poison the queue's scheduling chain.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Prevent queued work from starting. An active operation owns its own cancellation. */
  dispose(): void {
    this.disposed = true;
  }
}
