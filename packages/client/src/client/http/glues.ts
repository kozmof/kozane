import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import { readGlueCreated, readGlueRemoved } from "../decoders/cards.js";

export function createGlues(context: HttpResourceContext): KozaneClient["glues"] {
  return {
    create: (ns, input, options) =>
      context.writeDomain(context.ns(ns, "/glues"), "POST", input, readGlueCreated, options),
    remove: (ns, input, options) =>
      context.writeDomain(context.ns(ns, "/glues"), "DELETE", input, readGlueRemoved, options),
  };
}
