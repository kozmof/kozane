export interface AttemptTicket {
  readonly attempt: number;
  readonly generation: number;
}
export class SupersededAttemptError extends Error {
  override readonly name = "SupersededAttemptError";
  constructor() {
    super("Initialization attempt was superseded");
  }
}
export interface AttemptLease extends AttemptTicket {
  isCurrent(): boolean;
  assertCurrent(): void;
  onSuperseded(listener: () => void): () => void;
}
/** One root owns startup attempts and candidate generations. Destination changes use a separate tracker. */
export class AttemptOwner {
  private attempt = 0;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  isCurrent(ticket: AttemptTicket): boolean {
    return ticket.attempt === this.attempt && ticket.generation === this.generation;
  }
  private supersede(): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Ownership cannot depend on observer cleanup. */
      }
    }
  }
  begin(): AttemptLease {
    this.attempt++;
    const ticket = Object.freeze({ attempt: this.attempt, generation: this.generation });
    this.supersede();
    const isCurrent = () => this.isCurrent(ticket);
    return Object.freeze({
      ...ticket,
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) throw new SupersededAttemptError();
      },
      onSuperseded: (listener: () => void) => {
        if (!isCurrent()) {
          try {
            listener();
          } catch {
            /* An obsolete observer cannot acquire ownership. */
          }
          return () => {};
        }
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    });
  }
  replaceGeneration(): void {
    this.generation++;
    this.supersede();
  }
}
