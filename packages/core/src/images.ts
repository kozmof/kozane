/** Stored image references stay independent of the server serving the workspace. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export function imagePath(content: string): string | null {
  return /^kozane-image:\/api\/images\/[a-f0-9-]{36}\.(jpg|jpeg|png|svg)$/.test(content)
    ? content.slice(13)
    : null;
}
export function imageReference(path: string): string {
  if (!imagePath("kozane-image:" + path)) throw new Error("Invalid image path");
  return "kozane-image:" + path;
}
