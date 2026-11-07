import { createServiceContext } from "../../services/context.js";
import { canvasBounds } from "./canvas.js";
import { contentMax } from "./content-limit.js";

/** Resolve Node workspace configuration before entering transport-free services. */
export function workspaceServiceContext() {
  return createServiceContext({ contentMax: contentMax(), ...canvasBounds() });
}
