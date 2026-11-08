import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import type { MutationOptions } from "../contract.js";
import {
  readInventoryResult,
  readInventoryRemoved,
  readInventoryStowed,
  readInventoryTaken,
} from "../decoders/inventories.js";

export function createInventories(context: HttpResourceContext): KozaneClient["inventories"] {
  return {
    create: (ns: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, "/inventories"),
        "POST",
        input,
        (value) => readInventoryResult(value, ns),
        options,
      ),
    update: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/inventories/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        (value) => readInventoryResult(value, ns, id),
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/inventories/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readInventoryRemoved,
        options,
      ),
    stow: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/inventories/${encodeURIComponent(id)}/cards`),
        "POST",
        input,
        (value) => readInventoryStowed(value, id),
        options,
      ),
    take: (ns: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, "/inventories/take"),
        "POST",
        input,
        readInventoryTaken,
        options,
      ),
  };
}
