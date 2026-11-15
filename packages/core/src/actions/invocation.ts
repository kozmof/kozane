import { prepareInput } from "../services/prepare-input.js";
import { ValidationError } from "../errors.js";
import { actionContractsV1, type ActionInputsV1, type ActionKindV1 } from "./contracts.js";

type InputShapes = {
  [K in ActionKindV1]: {
    args: { [P in keyof ActionInputsV1[K]["args"]]: true };
    body: "body" extends keyof ActionInputsV1[K] ? true : false;
  };
};
const namespace = { namespaceId: true } as const;
const card = { ...namespace, cardId: true } as const;
const layer = { ...namespace, layerId: true } as const;
const partition = { ...namespace, partitionId: true } as const;
const scope = { ...namespace, scopeId: true } as const;
const area = { ...scope, areaId: true } as const;
const warp = { ...namespace, warpId: true } as const;
const inventory = { ...namespace, inventoryId: true } as const;
const taskspace = { ...namespace, taskspaceId: true } as const;

/** Shape checks cover routing, independently of service body validation. */
const inputShapes = {
  "cards.create": { args: namespace, body: true },
  "cards.update": { args: card, body: true },
  "cards.updatePositions": { args: namespace, body: true },
  "cards.remove": { args: namespace, body: true },
  "cards.removeOne": { args: card, body: false },
  "cards.move": { args: namespace, body: true },
  "cards.setLayer": { args: namespace, body: true },
  "cards.setPartition": { args: namespace, body: true },
  "cards.setStacking": { args: namespace, body: true },
  "cards.squash": { args: namespace, body: true },
  "glues.create": { args: namespace, body: true },
  "glues.remove": { args: namespace, body: true },
  "layers.create": { args: namespace, body: true },
  "layers.rename": { args: layer, body: true },
  "layers.remove": { args: layer, body: false },
  "layers.reorder": { args: namespace, body: true },
  "partitions.create": { args: namespace, body: true },
  "partitions.rename": { args: partition, body: true },
  "partitions.remove": { args: partition, body: false },
  "scopes.create": { args: namespace, body: true },
  "scopes.rename": { args: scope, body: true },
  "scopes.remove": { args: scope, body: false },
  "scopes.addMembers": { args: scope, body: true },
  "scopes.removeMembers": { args: scope, body: true },
  "scopes.createArea": { args: scope, body: true },
  "scopes.updateArea": { args: area, body: true },
  "scopes.removeArea": { args: area, body: false },
  "scopes.removeWorkspace": { args: { scopeId: true }, body: false },
  "warps.create": { args: namespace, body: true },
  "warps.update": { args: warp, body: true },
  "warps.remove": { args: warp, body: false },
  "inventories.create": { args: namespace, body: true },
  "inventories.update": { args: inventory, body: true },
  "inventories.remove": { args: inventory, body: false },
  "inventories.stow": { args: inventory, body: true },
  "inventories.take": { args: namespace, body: true },
  "namespaces.create": { args: {}, body: true },
  "namespaces.rename": { args: namespace, body: true },
  "namespaces.remove": { args: namespace, body: false },
  "namespaces.setDefault": { args: namespace, body: false },
  "taskspaces.create": { args: namespace, body: true },
  "taskspaces.rename": { args: taskspace, body: true },
  "taskspaces.remove": { args: taskspace, body: false },
  "taskspaces.createFile": { args: taskspace, body: true },
  "taskspaces.saveFile": { args: taskspace, body: true },
  "taskspaces.createDirectory": { args: taskspace, body: true },
  "taskspaces.renameEntry": { args: taskspace, body: true },
  "taskspaces.removeEntry": { args: { ...taskspace, path: true }, body: false },
} as const satisfies InputShapes;

export type PreparedActionInput = { args: Record<string, string>; body?: unknown };

/** Copy the original envelope before domain validation, preserving unresolved body values. */
export function prepareActionInputV1(kind: ActionKindV1, input: unknown): PreparedActionInput {
  if (!Object.hasOwn(actionContractsV1, kind))
    throw new ValidationError(`Unknown action kind: ${kind}`);
  const prepared = prepareInput(input);
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(prepared) || !object(prepared.args))
    throw new ValidationError(`Action ${kind} requires an args object`);
  const shape = inputShapes[kind];
  const names = Object.keys(shape.args);
  if (
    Object.keys(prepared.args).length !== names.length ||
    names.some(
      (key) =>
        !Object.hasOwn(prepared.args as object, key) ||
        typeof (prepared.args as Record<string, unknown>)[key] !== "string",
    )
  )
    throw new ValidationError(`Action ${kind} requires routing arguments: ${names.join(", ")}`);
  const hasBody = Object.hasOwn(prepared, "body");
  if (
    shape.body !== hasBody ||
    Object.keys(prepared).some((key) => key !== "args" && key !== "body")
  )
    throw new ValidationError(`Invalid invocation envelope for ${kind}`);
  return prepared as PreparedActionInput;
}
