/** Action identities must survive the existing recovery formats without normalization. */
export function isActionIdentity(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= 1000 &&
    !input.includes("\0") &&
    input.isWellFormed()
  );
}
