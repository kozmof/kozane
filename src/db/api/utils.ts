export class NotFoundError extends Error {
  constructor(label: string) {
    super(`${label} not found`);
    this.name = "NotFoundError";
  }
}

export class DefaultBundleError extends Error {
  constructor() {
    super("Cannot delete the default bundle");
    this.name = "DefaultBundleError";
  }
}

/** Throws if `rows` is empty — used to surface not-found errors from delete/update operations. */
export function assertFound<T>(rows: T[], label: string): void {
  if (rows.length === 0) throw new NotFoundError(label);
}

function messageInChain(e: unknown, text: string): boolean {
  if (!(e instanceof Error)) return false;
  if (e.message.includes(text)) return true;
  return messageInChain(e.cause, text);
}

export function isUniqueConstraintError(e: unknown): boolean {
  return messageInChain(e, "UNIQUE constraint failed");
}

export function isForeignKeyError(e: unknown): boolean {
  return messageInChain(e, "FOREIGN KEY constraint failed");
}
