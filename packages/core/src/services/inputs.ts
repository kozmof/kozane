/** Valid caller shapes. Services still validate untrusted data, finite numbers and configured limits. */
export type PositionInput = { posX: number; posY: number };
export type CardIdsInput = { cardIds: readonly string[] };
export type NamedInput = { name: string };
type AtLeastOne<T> = { [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>> }[keyof T];

export type CardCreateInput = {
  partitionId: string;
  content: string;
  /** Omission places the card at zero on that axis. */
  posX?: number;
  posY?: number;
  /** Omission puts the card on top of its layer. */
  zIndex?: number;
  /** Omitted references use the default layer and no scope or inventory. Null is invalid. */
  layerId?: string;
  scopeId?: string;
  inventoryId?: string;
};
export type CardUpdateFields = {
  content?: string;
  partitionId?: string;
  layerId?: string;
  posX?: number;
  posY?: number;
  zIndex?: number;
  /** Omission preserves pinned width. Null restores the configured default. */
  width?: number | null;
};
export type CardUpdateInput = AtLeastOne<CardUpdateFields>;
export type CardUpdatePositionsInput = {
  positions: readonly (PositionInput & { cardId: string })[];
};
export type CardRemoveInput = CardIdsInput;
export type CardMoveInput = CardIdsInput & { targetNamespaceId: string };
export type CardSetLayerInput = CardIdsInput & { layerId: string };
export type CardSetPartitionInput = CardIdsInput & { partitionId: string };
export type CardSetStackingInput = CardIdsInput & { direction: "front" | "back" };
export type CardSquashInput = { cardId: string };
export type GlueCreateInput = CardIdsInput;
export type GlueRemoveInput = CardIdsInput;
export type LayerCreateInput = NamedInput;
export type LayerRenameInput = NamedInput;
export type LayerReorderInput = { layerIds: readonly string[] };
export type PartitionCreateInput = NamedInput;
export type PartitionRenameInput = NamedInput;
export type ScopeCreateInput = NamedInput;
export type ScopeRenameInput = NamedInput;
export type ScopeAddMembersInput = CardIdsInput;
export type ScopeRemoveMembersInput = CardIdsInput;
export type ScopeCreateAreaInput = PositionInput & { width: number; height: number };
export type ScopeUpdateAreaInput = ScopeCreateAreaInput;
export type WarpCreateInput = PositionInput;
export type WarpUpdateInput = PositionInput;
export type InventoryCreateInput = PositionInput & { name?: string };
/** Positions are sent as a pair. At least a name or a position pair is required. */
export type InventoryUpdateInput =
  | { name: string; posX?: never; posY?: never }
  | (PositionInput & { name?: string });
/** Omission requests automatic placement. Null is invalid. */
export type InventoryStowInput = CardIdsInput & { slot?: number };
export type InventoryTakeCardInput = { cardId: string } & (
  | PositionInput
  | { posX?: never; posY?: never }
);
export type InventoryTakeInput = { cards: readonly InventoryTakeCardInput[] };
export type NamespaceCreateInput = NamedInput;
