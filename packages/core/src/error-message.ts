/** The message of a thrown value, which need not be an `Error`. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
