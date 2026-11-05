export type ViewFilters = {
  namespaceId: string | null;
  tag: string | null;
  day: string | null;
};
export type BoardDestination = {
  card?: string;
  warp?: string;
  taskspace?: string;
  path?: string;
};
/** Route policy supplied by the host to shared workspace views. */
export interface NavigationAdapter {
  namespaces(): string;
  board(namespaceId: string, destination?: BoardDestination): string;
  tags(filters?: Partial<Pick<ViewFilters, "namespaceId" | "tag">>): string;
  map(filters?: Partial<ViewFilters>): string;
  readFilters(url: URL): ViewFilters;
}
type Pairs = Record<string, string | null | undefined>;
function query(values: Pairs): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const result = params.toString();
  return result ? "?" + result : "";
}
function fragment(values: Pairs): string {
  const result = query(values);
  return result ? "#" + result.slice(1) : "";
}
/** Keep existing Node and SSG routes, including file-path escaping and warp arrival slashes. */
export function createNodeNavigation(
  options: {
    base?: string;
    boardTrailingSlash?: () => boolean;
  } = {},
): NavigationAdapter {
  const base = (options.base ?? "").replace(/\/+$/, "");
  return Object.freeze<NavigationAdapter>({
    namespaces: () => base + "/",
    board(namespaceId: string, destination: BoardDestination = {}) {
      const parts: string[] = [];
      for (const key of ["card", "warp", "taskspace", "path"] as const) {
        const value = destination[key];
        if (value) parts.push(key + "=" + encodeURIComponent(value));
      }
      return (
        base +
        "/" +
        encodeURIComponent(namespaceId) +
        (options.boardTrailingSlash?.() ? "/" : "") +
        (parts.length ? "?" + parts.join("&") : "")
      );
    },
    tags: ({ namespaceId, tag } = {}) => base + "/tags" + query({ namespaceId, tag }),
    map: ({ namespaceId, tag, day } = {}) => base + "/map" + query({ namespaceId, tag, day }),
    readFilters: (url: URL) => ({
      namespaceId: url.searchParams.get("namespaceId"),
      tag: url.searchParams.get("tag"),
      day: url.searchParams.get("day"),
    }),
  });
}
/** Fixed demo routes carry resource IDs in queries and content-bearing filters in fragments. */
export function createDemoNavigation(options: { base?: string } = {}): NavigationAdapter {
  const base = (options.base ?? "").replace(/\/+$/, "");
  return Object.freeze<NavigationAdapter>({
    namespaces: () => base + "/namespaces/",
    board: (namespaceId: string, destination: BoardDestination = {}) =>
      base +
      "/board/" +
      query({
        namespaceId,
        card: destination.card,
        warp: destination.warp,
        taskspace: destination.taskspace,
      }) +
      fragment({ path: destination.path }),
    tags: ({ namespaceId, tag } = {}) =>
      base + "/tags/" + query({ namespaceId }) + fragment({ tag }),
    map: ({ namespaceId, tag, day } = {}) =>
      base + "/map/" + query({ namespaceId }) + fragment({ tag, day }),
    readFilters(url: URL) {
      const content = new URLSearchParams(url.hash.slice(1));
      return {
        namespaceId: url.searchParams.get("namespaceId"),
        tag: content.get("tag"),
        day: content.get("day"),
      };
    },
  });
}
