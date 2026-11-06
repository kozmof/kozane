/** A destination change supersedes view work without restarting database-wide validation. */
export class DestinationTracker {
  private sequence = 0;
  constructor(private namespaceId?: string) {}
  select(namespaceId?: string): void {
    this.namespaceId = namespaceId;
    this.sequence++;
  }
  capture(): Readonly<{ sequence: number; namespaceId?: string }> {
    return Object.freeze({ sequence: this.sequence, namespaceId: this.namespaceId });
  }
  isCurrent(ticket: { sequence: number }): boolean {
    return ticket.sequence === this.sequence;
  }
  async resolve<View>(read: (namespaceId?: string) => Promise<View>): Promise<View> {
    while (true) {
      const ticket = this.capture();
      try {
        const view = await read(ticket.namespaceId);
        if (this.isCurrent(ticket)) return view;
      } catch (error) {
        if (this.isCurrent(ticket)) throw error;
      }
    }
  }
}
