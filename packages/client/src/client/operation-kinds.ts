import type { KozaneClient } from "./contract.js";

type ResourceKey = {
  [K in keyof KozaneClient]-?: NonNullable<KozaneClient[K]> extends object
    ? NonNullable<KozaneClient[K]> extends (...args: never[]) => unknown
      ? never
      : NonNullable<KozaneClient[K]>[keyof NonNullable<KozaneClient[K]>] extends (
            ...args: never[]
          ) => unknown
        ? K
        : never
    : never;
}[keyof KozaneClient];
type OperationKinds = {
  [K in ResourceKey]: { [M in keyof NonNullable<KozaneClient[K]>]: "read" | "write" };
};

/** Adding a resource or method requires an explicit dispatch classification. */
export const operationKinds = {
  cards: {
    create: "write",
    update: "write",
    updatePositions: "write",
    remove: "write",
    removeOne: "write",
    move: "write",
    setLayer: "write",
    setPartition: "write",
    setStacking: "write",
    squash: "write",
  },
  glues: { create: "write", remove: "write" },
  layers: { create: "write", rename: "write", remove: "write", reorder: "write" },
  partitions: { create: "write", rename: "write", remove: "write" },
  scopes: {
    create: "write",
    rename: "write",
    remove: "write",
    addMembers: "write",
    removeMembers: "write",
    createArea: "write",
    updateArea: "write",
    removeArea: "write",
  },
  warps: { create: "write", update: "write", remove: "write" },
  inventories: { create: "write", update: "write", remove: "write", stow: "write", take: "write" },
  namespaces: { list: "read", get: "read", create: "write" },
  taskspaces: {
    access: "read",
    create: "write",
    rename: "write",
    remove: "write",
    createFile: "write",
    readFile: "read",
    saveFile: "write",
    list: "read",
    createDirectory: "write",
    renameEntry: "write",
    removeEntry: "write",
  },
  tags: { get: "read" },
  map: { get: "read" },
  warpDirectory: { get: "read" },
} as const satisfies OperationKinds;
