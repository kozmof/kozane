export interface ResumeEvent {
  readonly sequence: number;
  readonly reason: "confirmed" | "ambiguous";
}
interface Pending {
  remaining: number;
  snapshot: number;
  updated: number;
  settled?: { ok: true; value: unknown } | { ok: false; error: unknown };
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}
/** One root shares active elapsed-time budgets across assets, initialization and worker messages. */
export class ActiveClock {
  private readonly entries = new Set<Pending>();
  private readonly reasons = new Set<string>();
  private readonly listeners = new Set<(event: ResumeEvent) => void>();
  private readonly resumes: ResumeEvent[] = [];
  private readonly gates = new Set<{ resolve(): void; reject(error: Error): void }>();
  private readonly failures = new Set<(error: Error) => void>();
  private heartbeat: number;
  private observation: number;
  private sequence = 0;
  private alarm: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(private readonly now: () => number = () => performance.now()) {
    this.heartbeat = this.observation = now();
    this.plan();
  }
  get running(): boolean {
    return (
      !this.disposed &&
      !this.paused &&
      !this.resumes.length &&
      ![...this.entries].some((entry) => !entry.settled && entry.remaining === 0)
    );
  }
  get paused(): boolean {
    return this.reasons.size > 0;
  }
  private time(): number {
    this.observation = Math.max(this.observation, this.now());
    return this.observation;
  }
  onResume(listener: (event: ResumeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    return () => {
      this.failures.delete(listener);
    };
  }
  whenRunning(): Promise<void> {
    this.check();
    if (this.disposed) return Promise.reject(new Error("Deadline clock is disposed"));
    if (
      !this.paused &&
      !this.resumes.length &&
      ![...this.entries].some((entry) => !entry.settled && entry.remaining === 0)
    )
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.gates.add({ resolve, reject });
    });
  }
  wait<T>(operation: Promise<T>, milliseconds: number, cleanup: () => void = () => {}): Promise<T> {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      void operation.catch(() => {});
      throw new RangeError("Deadline must be a positive finite duration");
    }
    if (this.disposed) {
      void operation.catch(() => {});
      return Promise.reject(new Error("Deadline clock is disposed"));
    }
    this.check();
    let entry: Pending;
    const result = new Promise<T>((resolve, reject) => {
      entry = {
        remaining: milliseconds,
        snapshot: milliseconds,
        updated: this.time(),
        resolve: (value) => resolve(value as T),
        reject,
        cleanup,
      };
      this.entries.add(entry);
    });
    const settle = (outcome: NonNullable<Pending["settled"]>) => {
      if (!this.entries.has(entry)) return;
      entry.settled = outcome;
      this.check();
      if (!this.paused && !this.resumes.length) this.finish(entry);
    };
    void operation.then(
      (value) => settle({ ok: true, value }),
      (error) => settle({ ok: false, error }),
    );
    this.plan();
    return result;
  }
  /** Call before dispatch and timeout decisions, not merely from the heartbeat timer. */
  check(): void {
    if (this.disposed || this.paused) return;
    const now = this.time();
    if (now - this.heartbeat > 2_000) {
      for (const entry of this.entries) {
        if (!entry.settled)
          entry.remaining = Math.min(entry.remaining, Math.max(0, entry.snapshot - 1_000));
        entry.snapshot = entry.remaining;
        entry.updated = now;
      }
      this.heartbeat = now;
      this.resumes.push(Object.freeze({ sequence: ++this.sequence, reason: "ambiguous" }));
      this.scheduleFlush();
    } else {
      for (const entry of this.entries) {
        if (!entry.settled) entry.remaining = Math.max(0, entry.remaining - (now - entry.updated));
        entry.updated = now;
      }
      if (now - this.heartbeat >= 1_000) {
        this.heartbeat = now;
        for (const entry of this.entries) entry.snapshot = entry.remaining;
      }
    }
    if ([...this.entries].some((entry) => !entry.settled && entry.remaining === 0))
      this.scheduleFlush();
    this.plan();
  }
  suspend(reason: string): void {
    if (this.disposed || this.reasons.has(reason)) return;
    this.check();
    this.reasons.add(reason);
    this.clearTimers();
  }
  resume(reason: string): void {
    if (this.disposed || !this.reasons.delete(reason) || this.paused) return;
    const now = this.time();
    this.heartbeat = now;
    for (const entry of this.entries) {
      entry.updated = now;
      entry.snapshot = entry.remaining;
    }
    this.resumes.push(Object.freeze({ sequence: ++this.sequence, reason: "confirmed" }));
    this.scheduleFlush();
    this.plan();
  }
  private finish(entry: Pending): void {
    if (!entry.settled || !this.entries.delete(entry)) return;
    if (entry.settled.ok) entry.resolve(entry.settled.value);
    else entry.reject(entry.settled.error);
    this.plan();
  }
  private scheduleFlush(): void {
    if (this.disposed || this.paused || this.flushTimer !== undefined) return;
    // Let already delivered promise/message results reconcile before evaluating overdue work.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 0);
  }
  private flush(): void {
    if (this.disposed || this.paused) return;
    const settled = [...this.entries].filter((entry) => entry.settled);
    for (const entry of settled) this.finish(entry);
    if (settled.length && [...this.entries].some((entry) => entry.remaining === 0)) {
      this.scheduleFlush();
      this.plan();
      return;
    }
    let expired = false;
    for (const entry of [...this.entries])
      if (entry.remaining === 0) {
        expired = true;
        this.entries.delete(entry);
        entry.reject(new Error("Stage deadline exceeded"));
        try {
          entry.cleanup();
        } catch {
          /* Deadline cleanup cannot restore an expired operation. */
        }
      }
    if (expired) {
      this.dispose(new Error("Stage deadline exceeded"));
      return;
    }
    const events = this.resumes.splice(0);
    for (const event of events)
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch (error) {
          this.dispose(error instanceof Error ? error : new Error("Resume observer failed"));
          return;
        }
      }
    if (this.paused || this.disposed) return;
    for (const gate of this.gates) gate.resolve();
    this.gates.clear();
    this.plan();
  }
  private clearTimers(): void {
    if (this.alarm !== undefined) clearTimeout(this.alarm);
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.alarm = this.flushTimer = undefined;
  }
  private plan(): void {
    if (this.alarm !== undefined) clearTimeout(this.alarm);
    this.alarm = undefined;
    if (this.disposed || this.paused) return;
    const pending = [...this.entries].filter((entry) => !entry.settled);
    if (pending.some((entry) => entry.remaining === 0)) return;
    const wait = Math.min(
      Math.max(0, this.heartbeat + 1_000 - this.time()),
      ...pending.map((entry) => entry.remaining),
    );
    this.alarm = setTimeout(() => {
      this.alarm = undefined;
      this.check();
    }, wait);
  }
  dispose(error: Error = new Error("Deadline clock is disposed")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    const entries = [...this.entries];
    this.entries.clear();
    this.listeners.clear();
    this.resumes.length = 0;
    for (const gate of this.gates) gate.reject(error);
    this.gates.clear();
    for (const entry of entries) {
      entry.reject(error);
      try {
        entry.cleanup();
      } catch {
        /* Disposal does not replay pending work. */
      }
    }
    const failures = [...this.failures];
    this.failures.clear();
    for (const listener of failures) {
      try {
        listener(error);
      } catch {
        /* Failure cleanup cannot revive a disposed clock. */
      }
    }
  }
}
