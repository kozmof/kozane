import type { Tx } from "../database.js";
import { ValidationError } from "../errors.js";
import type { ServiceContext } from "../services/context.js";
import { repairInTx } from "../services/inventories.js";
import { prepareInput } from "../services/prepare-input.js";
import { withActionService } from "./service-frame.js";

/** Explicit requested repair only. Exact restoration never calls this handler. */
export function runRequestedRepairInTx(db: Tx, context: ServiceContext, input: unknown) {
  return withActionService(db, async () => {
    const body = prepareInput(input);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, "target") ||
      !("target" in body) ||
      body.target !== "inventories"
    )
      throw new ValidationError("Repair requires exactly one target: inventories");
    return repairInTx(db, context);
  });
}
