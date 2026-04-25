export class NotFoundError extends Error {
  constructor(label: string) {
    super(`${label} not found`);
    this.name = "NotFoundError";
  }
}

/** Throws if `rows` is empty — used to surface not-found errors from delete/update operations. */
export function assertFound<T>(rows: T[], label: string): void {
  if (rows.length === 0) throw new NotFoundError(label);
}
