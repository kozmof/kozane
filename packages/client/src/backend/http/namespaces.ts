import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import type { ReadOptions } from "../contract.js";
import { readNamespaceList, readNamespaceMetadata } from "../decoders/namespaces.js";
import { readNamespaceCreated } from "../decoders/structure.js";
import { ClientError } from "../contract.js";

export function createNamespaces(context: HttpResourceContext): KozaneClient["namespaces"] {
  return {
    list: async (options) => {
      const result = readNamespaceList(await context.read<unknown>("/api/namespaces", options));
      if (!result) throw new ClientError("unavailable", "Invalid namespace list");
      return result;
    },
    get: async (namespaceId: string, options?: ReadOptions) => {
      const result = readNamespaceMetadata(
        await context.read<unknown>(`/api/namespaces/${encodeURIComponent(namespaceId)}`, options),
      );
      if (!result || result.id !== namespaceId)
        throw new ClientError("unavailable", "Invalid namespace metadata");
      return result;
    },
    create: (input: { name: string }) =>
      context.writeDomain("/api/namespaces", "POST", input, readNamespaceCreated),
  };
}
