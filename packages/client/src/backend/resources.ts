import type {
  CardCreateInput,
  CardUpdateInput,
  CardUpdatePositionsInput,
  CardRemoveInput,
  CardMoveInput,
  CardSetLayerInput,
  CardSetPartitionInput,
  CardSetStackingInput,
  CardSquashInput,
  GlueCreateInput,
  GlueRemoveInput,
  LayerCreateInput,
  LayerRenameInput,
  LayerReorderInput,
  PartitionCreateInput,
  PartitionRenameInput,
  ScopeCreateInput,
  ScopeRenameInput,
  ScopeAddMembersInput,
  ScopeRemoveMembersInput,
  ScopeCreateAreaInput,
  ScopeUpdateAreaInput,
  WarpCreateInput,
  WarpUpdateInput,
  InventoryCreateInput,
  InventoryUpdateInput,
  InventoryStowInput,
  InventoryTakeInput,
  NamespaceCreateInput,
} from "../../../../src/services/inputs.js";
export type * from "../../../../src/services/inputs.js";
import type * as CardsServices from "../../../../src/services/cards.js";
import type * as GluesServices from "../../../../src/services/glues.js";
import type * as LayersServices from "../../../../src/services/layers.js";
import type * as PartitionsServices from "../../../../src/services/partitions.js";
import type * as ScopesServices from "../../../../src/services/scopes.js";
import type * as WarpsServices from "../../../../src/services/warps.js";
import type * as InventoriesServices from "../../../../src/services/inventories.js";
import type * as NamespaceServices from "../../../../src/services/namespaces.js";
import type { TagsViewData } from "../../../../src/services/tags.js";
import type { TreemapSnapshot } from "../../../../src/services/map.js";
import type { WarpListEntry } from "../../../../src/lib/warp-list.js";
export type * from "./taskspaces-api.js";

export interface MutationOptions {
  keepalive?: boolean;
}
type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export type CardCreateResult = Result<typeof CardsServices.create>;
export type CardUpdateResult = Result<typeof CardsServices.update>;
export type CardUpdatePositionsResult = Result<typeof CardsServices.updatePositions>;
export type CardRemoveResult = Result<typeof CardsServices.remove>;
export type CardRemoveOneResult = Result<typeof CardsServices.removeOne>;
export type CardMoveResult = Result<typeof CardsServices.move>;
export type CardSetLayerResult = Result<typeof CardsServices.setLayer>;
export type CardSetPartitionResult = Result<typeof CardsServices.setPartition>;
export type CardSetStackingResult = Result<typeof CardsServices.setStacking>;
export type CardSquashResult = Result<typeof CardsServices.squash>;
export interface CardsApi {
  create(
    namespaceId: string,
    input: CardCreateInput,
    options?: MutationOptions,
  ): Promise<CardCreateResult>;
  update(
    namespaceId: string,
    cardId: string,
    input: CardUpdateInput,
    options?: MutationOptions,
  ): Promise<CardUpdateResult>;
  updatePositions(
    namespaceId: string,
    input: CardUpdatePositionsInput,
    options?: MutationOptions,
  ): Promise<CardUpdatePositionsResult>;
  remove(namespaceId: string, input: CardRemoveInput): Promise<CardRemoveResult>;
  removeOne(namespaceId: string, cardId: string): Promise<CardRemoveOneResult>;
  move(namespaceId: string, input: CardMoveInput): Promise<CardMoveResult>;
  setLayer(namespaceId: string, input: CardSetLayerInput): Promise<CardSetLayerResult>;
  setPartition(namespaceId: string, input: CardSetPartitionInput): Promise<CardSetPartitionResult>;
  setStacking(namespaceId: string, input: CardSetStackingInput): Promise<CardSetStackingResult>;
  squash(namespaceId: string, input: CardSquashInput): Promise<CardSquashResult>;
}

export type GlueCreateResult = Result<typeof GluesServices.create>;
export type GlueRemoveResult = Result<typeof GluesServices.remove>;
export interface GluesApi {
  create(
    namespaceId: string,
    input: GlueCreateInput,
    options?: MutationOptions,
  ): Promise<GlueCreateResult>;
  remove(
    namespaceId: string,
    input: GlueRemoveInput,
    options?: MutationOptions,
  ): Promise<GlueRemoveResult>;
}

export type LayerCreateResult = Result<typeof LayersServices.create>;
export type LayerRenameResult = Result<typeof LayersServices.rename>;
export type LayerRemoveResult = Result<typeof LayersServices.remove>;
export type LayerReorderResult = Result<typeof LayersServices.reorder>;
export interface LayersApi {
  create(
    namespaceId: string,
    input: LayerCreateInput,
    options?: MutationOptions,
  ): Promise<LayerCreateResult>;
  rename(
    namespaceId: string,
    layerId: string,
    input: LayerRenameInput,
    options?: MutationOptions,
  ): Promise<LayerRenameResult>;
  remove(
    namespaceId: string,
    layerId: string,
    options?: MutationOptions,
  ): Promise<LayerRemoveResult>;
  reorder(
    namespaceId: string,
    input: LayerReorderInput,
    options?: MutationOptions,
  ): Promise<LayerReorderResult>;
}

export type PartitionCreateResult = Result<typeof PartitionsServices.create>;
export type PartitionRenameResult = Result<typeof PartitionsServices.rename>;
export type PartitionRemoveResult = Result<typeof PartitionsServices.remove>;
export interface PartitionsApi {
  create(
    namespaceId: string,
    input: PartitionCreateInput,
    options?: MutationOptions,
  ): Promise<PartitionCreateResult>;
  rename(
    namespaceId: string,
    partitionId: string,
    input: PartitionRenameInput,
    options?: MutationOptions,
  ): Promise<PartitionRenameResult>;
  remove(
    namespaceId: string,
    partitionId: string,
    options?: MutationOptions,
  ): Promise<PartitionRemoveResult>;
}

export type ScopeCreateResult = Result<typeof ScopesServices.create>;
export type ScopeRenameResult = Result<typeof ScopesServices.rename>;
export type ScopeRemoveResult = Result<typeof ScopesServices.remove>;
export type ScopeAddMembersResult = Result<typeof ScopesServices.addMembers>;
export type ScopeRemoveMembersResult = Result<typeof ScopesServices.removeMembers>;
export type ScopeCreateAreaResult = Result<typeof ScopesServices.createArea>;
export type ScopeUpdateAreaResult = Result<typeof ScopesServices.updateArea>;
export type ScopeRemoveAreaResult = Result<typeof ScopesServices.removeArea>;
export interface ScopesApi {
  create(
    namespaceId: string,
    input: ScopeCreateInput,
    options?: MutationOptions,
  ): Promise<ScopeCreateResult>;
  rename(
    namespaceId: string,
    scopeId: string,
    input: ScopeRenameInput,
    options?: MutationOptions,
  ): Promise<ScopeRenameResult>;
  remove(
    namespaceId: string,
    scopeId: string,
    options?: MutationOptions,
  ): Promise<ScopeRemoveResult>;
  addMembers(
    namespaceId: string,
    scopeId: string,
    input: ScopeAddMembersInput,
    options?: MutationOptions,
  ): Promise<ScopeAddMembersResult>;
  removeMembers(
    namespaceId: string,
    scopeId: string,
    input: ScopeRemoveMembersInput,
    options?: MutationOptions,
  ): Promise<ScopeRemoveMembersResult>;
  createArea(
    namespaceId: string,
    scopeId: string,
    input: ScopeCreateAreaInput,
    options?: MutationOptions,
  ): Promise<ScopeCreateAreaResult>;
  updateArea(
    namespaceId: string,
    scopeId: string,
    areaId: string,
    input: ScopeUpdateAreaInput,
    options?: MutationOptions,
  ): Promise<ScopeUpdateAreaResult>;
  removeArea(
    namespaceId: string,
    scopeId: string,
    areaId: string,
    options?: MutationOptions,
  ): Promise<ScopeRemoveAreaResult>;
}

export type WarpCreateResult = Result<typeof WarpsServices.create>;
export type WarpUpdateResult = Result<typeof WarpsServices.update>;
export type WarpRemoveResult = Result<typeof WarpsServices.remove>;
export interface WarpsApi {
  create(
    namespaceId: string,
    input: WarpCreateInput,
    options?: MutationOptions,
  ): Promise<WarpCreateResult>;
  update(
    namespaceId: string,
    warpId: string,
    input: WarpUpdateInput,
    options?: MutationOptions,
  ): Promise<WarpUpdateResult>;
  remove(namespaceId: string, warpId: string, options?: MutationOptions): Promise<WarpRemoveResult>;
}

export type InventoryCreateResult = Result<typeof InventoriesServices.create>;
export type InventoryUpdateResult = Result<typeof InventoriesServices.update>;
export type InventoryRemoveResult = Result<typeof InventoriesServices.remove>;
export type InventoryStowResult = Result<typeof InventoriesServices.stow>;
export type InventoryTakeResult = Result<typeof InventoriesServices.take>;
export interface InventoriesApi {
  create(
    namespaceId: string,
    input: InventoryCreateInput,
    options?: MutationOptions,
  ): Promise<InventoryCreateResult>;
  update(
    namespaceId: string,
    inventoryId: string,
    input: InventoryUpdateInput,
    options?: MutationOptions,
  ): Promise<InventoryUpdateResult>;
  remove(
    namespaceId: string,
    inventoryId: string,
    options?: MutationOptions,
  ): Promise<InventoryRemoveResult>;
  stow(
    namespaceId: string,
    inventoryId: string,
    input: InventoryStowInput,
    options?: MutationOptions,
  ): Promise<InventoryStowResult>;
  take(
    namespaceId: string,
    input: InventoryTakeInput,
    options?: MutationOptions,
  ): Promise<InventoryTakeResult>;
}

export type NamespaceCreateResult = Result<typeof NamespaceServices.create>;
export type NamespaceListResult = Result<typeof NamespaceServices.list>;
export type NamespaceGetResult = Result<typeof NamespaceServices.get>;
export interface NamespacesApi {
  list(): Promise<NamespaceListResult>;
  get(namespaceId: string): Promise<NamespaceGetResult>;
  create(input: NamespaceCreateInput): Promise<NamespaceCreateResult>;
}
export type TagsResult = TagsViewData;
export interface TagsApi {
  get(namespaceId?: string): Promise<TagsResult>;
}
export type MapResult = TreemapSnapshot;
export interface MapApi {
  get(): Promise<MapResult>;
}
export type WarpDirectoryResult = WarpListEntry[];
export interface WarpDirectoryApi {
  get(namespaceId: string): Promise<WarpDirectoryResult>;
}
