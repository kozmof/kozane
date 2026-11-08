import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import { readMutationOk } from "../decoders/structure.js";
import {
  readCardCreated,
  readCardUpdated,
  readCardStacked,
  readCardSquashed,
} from "../decoders/cards.js";

export function createCards(context: HttpResourceContext): KozaneClient["cards"] {
  return {
    create: (ns, input, options) =>
      context.writeDomain(context.ns(ns, "/cards"), "POST", input, readCardCreated, options),
    update: (ns, id, input, options) =>
      context.writeDomain(
        context.ns(ns, `/cards/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        (value, prepared) => readCardUpdated(value, id, prepared),
        options,
      ),
    updatePositions: (ns, input, options) =>
      context.writeDomain(context.ns(ns, "/cards"), "PATCH", input, readMutationOk, options),
    remove: (ns, input) =>
      context.writeDomain(context.ns(ns, "/cards"), "DELETE", input, readMutationOk),
    removeOne: (ns, id) =>
      context.writeDomain(
        context.ns(ns, `/cards/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readMutationOk,
      ),
    move: (ns, input) =>
      context.writeDomain(context.ns(ns, "/cards/move"), "POST", input, readMutationOk),
    setLayer: (ns, input) =>
      context.writeDomain(context.ns(ns, "/cards/layer"), "PATCH", input, readCardStacked),
    setPartition: (ns, input) =>
      context.writeDomain(context.ns(ns, "/cards/partition"), "PATCH", input, readMutationOk),
    setStacking: (ns, input) =>
      context.writeDomain(context.ns(ns, "/cards/stacking"), "PATCH", input, readCardStacked),
    squash: (ns, input) =>
      context.writeDomain(context.ns(ns, "/cards/squash"), "POST", input, (value) =>
        readCardSquashed(value, ns),
      ),
  };
}
