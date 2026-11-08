import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import type { MutationOptions } from "../contract.js";
import { readMutationOk, readLayerCreated, readLayerRemoved } from "../decoders/structure.js";

export function createLayers(context: HttpResourceContext): KozaneClient["layers"] {
  return {
    create: (ns: string, input, options?: MutationOptions) =>
      context.writeDomain(context.ns(ns, "/layers"), "POST", input, readLayerCreated, options),
    rename: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/layers/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        readMutationOk,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/layers/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readLayerRemoved,
        options,
      ),
    reorder: (ns: string, input, options?: MutationOptions) =>
      context.writeDomain(context.ns(ns, "/layers"), "PATCH", input, readMutationOk, options),
  };
}
