import type * as Input from "../services/inputs.js";

/** Version the invocation and binding contract independently from the SQLite schema. */
export const ACTION_CONTRACT_VERSION = 1;
type NamespaceArgs = { namespaceId: string };
type TargetArgs<K extends string> = NamespaceArgs & Record<K, string>;
type Envelope<A, B = never> = [B] extends [never] ? { args: A } : { args: A; body: B };
type EmptyArgs = Record<string, never>;

/** Original caller arguments, including route IDs, before domain normalization. */
export interface ActionInputsV1 {
  "system.compose": Envelope<EmptyArgs, { children: readonly CompositionChildV1[] }>;
  "system.repair": Envelope<EmptyArgs, { target: "inventories" }>;
  "cards.create": Envelope<NamespaceArgs, Input.CardCreateInput>;
  "cards.update": Envelope<TargetArgs<"cardId">, Input.CardUpdateInput>;
  "cards.updatePositions": Envelope<NamespaceArgs, Input.CardUpdatePositionsInput>;
  "cards.remove": Envelope<NamespaceArgs, Input.CardRemoveInput>;
  "cards.removeOne": Envelope<TargetArgs<"cardId">>;
  "cards.move": Envelope<NamespaceArgs, Input.CardMoveInput>;
  "cards.setLayer": Envelope<NamespaceArgs, Input.CardSetLayerInput>;
  "cards.setPartition": Envelope<NamespaceArgs, Input.CardSetPartitionInput>;
  "cards.setStacking": Envelope<NamespaceArgs, Input.CardSetStackingInput>;
  "cards.squash": Envelope<NamespaceArgs, Input.CardSquashInput>;
  "glues.create": Envelope<NamespaceArgs, Input.GlueCreateInput>;
  "glues.remove": Envelope<NamespaceArgs, Input.GlueRemoveInput>;
  "layers.create": Envelope<NamespaceArgs, Input.LayerCreateInput>;
  "layers.rename": Envelope<TargetArgs<"layerId">, Input.LayerRenameInput>;
  "layers.remove": Envelope<TargetArgs<"layerId">>;
  "layers.reorder": Envelope<NamespaceArgs, Input.LayerReorderInput>;
  "partitions.create": Envelope<NamespaceArgs, Input.PartitionCreateInput>;
  "partitions.rename": Envelope<TargetArgs<"partitionId">, Input.PartitionRenameInput>;
  "partitions.remove": Envelope<TargetArgs<"partitionId">>;
  "scopes.create": Envelope<NamespaceArgs, Input.ScopeCreateInput>;
  "scopes.rename": Envelope<TargetArgs<"scopeId">, Input.ScopeRenameInput>;
  "scopes.remove": Envelope<TargetArgs<"scopeId">>;
  "scopes.addMembers": Envelope<TargetArgs<"scopeId">, Input.ScopeAddMembersInput>;
  "scopes.removeMembers": Envelope<TargetArgs<"scopeId">, Input.ScopeRemoveMembersInput>;
  "scopes.createArea": Envelope<TargetArgs<"scopeId">, Input.ScopeCreateAreaInput>;
  "scopes.updateArea": Envelope<TargetArgs<"scopeId" | "areaId">, Input.ScopeUpdateAreaInput>;
  "scopes.removeArea": Envelope<TargetArgs<"scopeId" | "areaId">>;
  "scopes.removeWorkspace": Envelope<{ scopeId: string }>;
  "warps.create": Envelope<NamespaceArgs, Input.WarpCreateInput>;
  "warps.update": Envelope<TargetArgs<"warpId">, Input.WarpUpdateInput>;
  "warps.remove": Envelope<TargetArgs<"warpId">>;
  "inventories.create": Envelope<NamespaceArgs, Input.InventoryCreateInput>;
  "inventories.update": Envelope<TargetArgs<"inventoryId">, Input.InventoryUpdateInput>;
  "inventories.remove": Envelope<TargetArgs<"inventoryId">>;
  "inventories.stow": Envelope<TargetArgs<"inventoryId">, Input.InventoryStowInput>;
  "inventories.take": Envelope<NamespaceArgs, Input.InventoryTakeInput>;
  "namespaces.create": Envelope<EmptyArgs, Input.NamespaceCreateInput>;
  "namespaces.rename": Envelope<NamespaceArgs, Input.NamedInput>;
  "namespaces.remove": Envelope<NamespaceArgs>;
  "namespaces.setDefault": Envelope<NamespaceArgs>;
  "taskspaces.create": Envelope<NamespaceArgs, { name: string; scopeId: string }>;
  "taskspaces.rename": Envelope<TargetArgs<"taskspaceId">, Input.NamedInput>;
  "taskspaces.remove": Envelope<TargetArgs<"taskspaceId">>;
  "taskspaces.createFile": Envelope<TargetArgs<"taskspaceId">, { path: string }>;
  "taskspaces.saveFile": Envelope<
    TargetArgs<"taskspaceId">,
    {
      path: string;
      content: string;
      signature: string | null;
    }
  >;
  "taskspaces.createDirectory": Envelope<TargetArgs<"taskspaceId">, { path: string }>;
  "taskspaces.renameEntry": Envelope<TargetArgs<"taskspaceId">, { path: string; name: string }>;
  "taskspaces.removeEntry": Envelope<TargetArgs<"taskspaceId"> & { path: string }>;
}
export type ActionKindV1 = keyof ActionInputsV1;

/** Contract declarations only. Activation still requires registered handlers and proven capture. */
export const actionContractsV1 = Object.freeze({
  "system.compose": "syncable",
  "system.repair": "syncable",
  "cards.create": "syncable",
  "cards.update": "syncable",
  "cards.updatePositions": "syncable",
  "cards.remove": "syncable",
  "cards.removeOne": "syncable",
  "cards.move": "syncable",
  "cards.setLayer": "syncable",
  "cards.setPartition": "syncable",
  "cards.setStacking": "syncable",
  "cards.squash": "syncable",
  "glues.create": "syncable",
  "glues.remove": "syncable",
  "layers.create": "syncable",
  "layers.rename": "syncable",
  "layers.remove": "syncable",
  "layers.reorder": "syncable",
  "partitions.create": "syncable",
  "partitions.rename": "syncable",
  "partitions.remove": "syncable",
  "scopes.create": "syncable",
  "scopes.rename": "syncable",
  "scopes.remove": "syncable",
  "scopes.addMembers": "syncable",
  "scopes.removeMembers": "syncable",
  "scopes.createArea": "syncable",
  "scopes.updateArea": "syncable",
  "scopes.removeArea": "syncable",
  "scopes.removeWorkspace": "syncable",
  "warps.create": "syncable",
  "warps.update": "syncable",
  "warps.remove": "syncable",
  "inventories.create": "syncable",
  "inventories.update": "syncable",
  "inventories.remove": "syncable",
  "inventories.stow": "syncable",
  "inventories.take": "syncable",
  "namespaces.create": "syncable",
  "namespaces.rename": "syncable",
  "namespaces.remove": "syncable",
  "namespaces.setDefault": "syncable",
  // Lifecycle methods currently mix filesystem work and shared database writes.
  "taskspaces.create": "local-only",
  "taskspaces.rename": "local-only",
  "taskspaces.remove": "local-only",
  "taskspaces.createFile": "local-only",
  "taskspaces.saveFile": "local-only",
  "taskspaces.createDirectory": "local-only",
  "taskspaces.renameEntry": "local-only",
  "taskspaces.removeEntry": "local-only",
} as const satisfies Record<ActionKindV1, "syncable" | "local-only">);

export type SyncableActionKindV1 = {
  [K in ActionKindV1]: (typeof actionContractsV1)[K] extends "syncable" ? K : never;
}[ActionKindV1];

/** Direct child invocations only. Named handlers own their descendants. */
export type CompositionChildV1 = {
  [K in SyncableActionKindV1]: {
    readonly id: string;
    readonly path: readonly string[];
    readonly kind: K;
    readonly input: ActionInputsV1[K];
  };
}[SyncableActionKindV1];
