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
  "system.compose": { args: {}, body: true },
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

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validateEnvelope(
  kind: ActionKindV1,
  prepared: unknown,
  childIds: Set<string>,
): asserts prepared is PreparedActionInput {
  if (!Object.hasOwn(actionContractsV1, kind))
    throw new ValidationError(`Unknown action kind: ${kind}`);
  if (!object(prepared) || !object(prepared.args))
    throw new ValidationError(`Action ${kind} requires an args object`);
  const args = prepared.args;
  const shape = inputShapes[kind];
  const names = Object.keys(shape.args);
  if (
    Object.keys(args).length !== names.length ||
    names.some((key) => !Object.hasOwn(args, key) || typeof args[key] !== "string")
  )
    throw new ValidationError(`Action ${kind} requires routing arguments: ${names.join(", ")}`);
  if (
    shape.body !== Object.hasOwn(prepared, "body") ||
    Object.keys(prepared).some((key) => key !== "args" && key !== "body")
  )
    throw new ValidationError(`Invalid invocation envelope for ${kind}`);
  if (kind !== "system.compose") return;
  const body = prepared.body;
  if (!object(body) || Object.keys(body).length !== 1 || !Array.isArray(body.children))
    throw new ValidationError("Composition body requires an ordered children list");
  const paths = new Set<string>();
  for (const child of body.children) {
    if (
      !object(child) ||
      Object.keys(child).length !== 4 ||
      typeof child.id !== "string" ||
      !child.id ||
      typeof child.kind !== "string" ||
      !Object.hasOwn(actionContractsV1, child.kind) ||
      !Object.hasOwn(child, "input") ||
      !Array.isArray(child.path) ||
      !child.path.length ||
      child.path.some((key: unknown) => typeof key !== "string" || !key)
    )
      throw new ValidationError("Invalid recorded composition child");
    const childKind = child.kind as ActionKindV1;
    if (actionContractsV1[childKind] !== "syncable")
      throw new ValidationError(`Composition child is local-only: ${childKind}`);
    const path = JSON.stringify([childKind, ...child.path]);
    if (childIds.has(child.id) || paths.has(path))
      throw new ValidationError("Duplicate composition child ID or path");
    childIds.add(child.id);
    paths.add(path);
    validateEnvelope(childKind, child.input, childIds);
  }
}

/** Copy the original envelope before domain validation, preserving unresolved body values. */
export function prepareActionInputV1(kind: ActionKindV1, input: unknown): PreparedActionInput {
  const prepared = prepareInput(input);
  validateEnvelope(kind, prepared, new Set());
  return prepared;
}
