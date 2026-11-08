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

  /** Prevent queued and future work from starting.
   * Active work continues through commit or rollback and cleanup. Disposal does
   * not await it. Await active work before closing its database. Operations must
   * finish asynchronous cleanup before settling their returned promise.
   */
  /** Stop new work and await active cleanup before closing storage. */
  async close(): Promise<void> {
    this.dispose();
    await this.tail;
  }

  dispose(): void {
    this.disposed = true;
  }
}
