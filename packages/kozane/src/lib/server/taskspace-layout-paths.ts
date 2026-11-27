import { resolve } from "node:path";
import { MIN_SHORT_ID_LENGTH, shortIdKey } from "../short-id-key.js";
import { isStrictlyInside } from "./fs-paths.js";

/** Every possible location of an owned directory during one layout move. */
export function taskspaceLayoutPaths(
  root: string,
  from: string,
  to: string,
  taskspaceId: string,
): string[] {
  return isStrictlyInside(resolve(root, from), resolve(root, to))
    ? [from, `${from}.kozane-move-${shortIdKey(taskspaceId).slice(0, MIN_SHORT_ID_LENGTH)}`, to]
    : [from, to];
}
