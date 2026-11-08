import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import type { ReadOptions } from "../contract.js";
import { parseWarpEntries } from "../decoders/warp-directory.js";
import { readTagsViewData } from "../decoders/tags.js";
import { readMapSnapshot } from "../decoders/map.js";
import { ClientError } from "../contract.js";

export function createTags(context: HttpResourceContext): KozaneClient["tags"] {
  return {
    get: async (namespaceId?: string, options?: ReadOptions) => {
      const result = readTagsViewData(
        await context.read<unknown>(
          "/api/tags" +
            (namespaceId !== undefined ? "?namespaceId=" + encodeURIComponent(namespaceId) : ""),
          { ...options, cache: "no-store" },
        ),
      );
      if (!result) throw new ClientError("unavailable", "Invalid tags dataset");
      return result;
    },
  };
}

export function createMap(context: HttpResourceContext): KozaneClient["map"] {
  return {
    get: async (options) => {
      const result = readMapSnapshot(
        await context.read<unknown>("/api/map", { ...options, cache: "no-store" }),
      );
      if (!result) throw new ClientError("unavailable", "Invalid map dataset");
      return result;
    },
  };
}

export function createWarpDirectory(context: HttpResourceContext): KozaneClient["warpDirectory"] {
  return {
    get: async (namespaceId: string, options?: ReadOptions) => {
      const result = parseWarpEntries(
        await context.read<unknown>(context.ns(namespaceId, "/warp-directory"), options),
      );
      if (!result) throw new ClientError("unavailable", "Invalid warp directory");
      return result;
    },
  };
}
