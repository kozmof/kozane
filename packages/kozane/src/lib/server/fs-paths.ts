import type { Stats } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** True when `child` sits strictly underneath `parent`. Compares whole path segments. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** True when `child` is `parent` itself or sits underneath it. */
export function isWithin(parent: string, child: string): boolean {
  return relative(parent, child) === "" || isStrictlyInside(parent, child);
}

/** The `code` of a Node filesystem error, such as `ENOENT`, or undefined. */
export function errorCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

/** True when two `lstat` results describe the same entry on disk. */
export function sameEntry(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}
