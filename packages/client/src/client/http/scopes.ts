import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import type { MutationOptions } from "../contract.js";
import { readMutationOk, readCreatedId } from "../decoders/structure.js";
import { readScopeRenamed, readScopeAreaResult } from "../decoders/geometry.js";

export function createScopes(context: HttpResourceContext): KozaneClient["scopes"] {
  return {
    create: (ns: string, input, options?: MutationOptions) =>
      context.writeDomain(context.ns(ns, "/scopes"), "POST", input, readCreatedId, options),
    rename: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/scopes/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        (value) => readScopeRenamed(value, id),
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/scopes/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readMutationOk,
        options,
      ),
    addMembers: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/scopes/${encodeURIComponent(id)}/members`),
        "POST",
        input,
        readMutationOk,
        options,
      ),
    removeMembers: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/scopes/${encodeURIComponent(id)}/members`),
        "DELETE",
        input,
        readMutationOk,
        options,
      ),
    createArea: (ns: string, id: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/scopes/${encodeURIComponent(id)}/areas`),
        "POST",
        input,
        (value) => readScopeAreaResult(value, ns, id),
        options,
      ),
    updateArea: (ns: string, id: string, areaId: string, input, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/scopes/${encodeURIComponent(id)}/areas/${encodeURIComponent(areaId)}`),
        "PATCH",
        input,
        (value) => readScopeAreaResult(value, ns, id, areaId),
        options,
      ),
    removeArea: (ns: string, id: string, areaId: string, options?: MutationOptions) =>
      context.writeDomain(
        context.ns(ns, `/scopes/${encodeURIComponent(id)}/areas/${encodeURIComponent(areaId)}`),
        "DELETE",
        undefined,
        readMutationOk,
        options,
      ),
  };
}
