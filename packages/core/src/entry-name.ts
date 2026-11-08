/**
 * Why `name` cannot name a taskspace file or folder, or null when it can. Allow one plain
 * segment only, so a create or rename never reaches another directory or hides the entry.
 * Shared by the server, which enforces it, and the browser, which checks before asking.
 *
 * `label` starts each message, such as "File name" or "Name".
 */
export function entryNameIssue(name: string, label = "Name"): string | null {
  if (!name.trim()) return `${label} is required`;
  if (name !== name.trim()) return `${label} cannot start or end with whitespace`;
  if (/[/\\\0]/.test(name)) return `${label} cannot contain a path separator`;
  if (name.startsWith(".")) return `${label} cannot start with a dot`;
  return null;
}
