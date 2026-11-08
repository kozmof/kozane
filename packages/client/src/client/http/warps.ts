import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import type { MutationOptions } from "../contract.js";
import { readMutationOk } from "../decoders/structure.js";
import { readWarpResult } from "../decoders/geometry.js";

export function createWarps(context: HttpResourceContext): KozaneClient["warps"] {
  return {
    create: (ns: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, "/warps"),
        "POST",
        input,
        (value) => readWarpResult(value, ns),
        options,
      ),
    update: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/warps/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        (value) => readWarpResult(value, ns, id),
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/warps/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readMutationOk,
        options,
      ),
  };
}
