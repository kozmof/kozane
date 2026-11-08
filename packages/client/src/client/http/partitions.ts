import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import type { MutationOptions } from "../contract.js";
import { readMutationOk, readCreatedId, readPartitionRemoved } from "../decoders/structure.js";

export function createPartitions(context: HttpResourceContext): KozaneClient["partitions"] {
  return {
    create: (ns: string, input, options?: MutationOptions) =>
      context.writeDomain(context.ns(ns, "/partitions"), "POST", input, readCreatedId, options),
    rename: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/partitions/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        readMutationOk,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/partitions/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readPartitionRemoved,
        options,
      ),
  };
}
