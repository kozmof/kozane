import { getContext } from "svelte";
export const IMAGE_RESOLVER = Symbol("kozane.imageResolver");
export function useImageResolver(): (path: string) => string {
  return getContext<(path: string) => string>(IMAGE_RESOLVER) ?? ((path) => path);
}
