import type * as CardsServices from "../../services/cards.js";
import type * as GluesServices from "../../services/glues.js";
import type * as LayersServices from "../../services/layers.js";
import type * as PartitionsServices from "../../services/partitions.js";
import type * as ScopesServices from "../../services/scopes.js";
import type * as WarpsServices from "../../services/warps.js";
import type * as InventoriesServices from "../../services/inventories.js";
import type * as NamespaceServices from "../../services/namespaces.js";
import type { TagsViewData } from "../../services/tags.js";
import type { TreemapSnapshot } from "../../services/map.js";
import type { WarpListEntry } from "../warp-list.js";
export type {
  TaskspacesApi,
  TaskspaceLifecycleApi,
  TaskspaceCreated,
  TaskspaceRenamed,
  TaskspaceFileData,
} from "./taskspaces-api.js";

export interface MutationOptions {
  keepalive?: boolean;
}
type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

// Inputs mirror the core services' untrusted-data boundary.
export type CardCreateInput = Parameters<typeof CardsServices.create>[3];
export type CardCreateResult = Result<typeof CardsServices.create>;
export type CardUpdateInput = Parameters<typeof CardsServices.update>[4];
export type CardUpdateResult = Result<typeof CardsServices.update>;
export type CardUpdatePositionsInput = Parameters<typeof CardsServices.updatePositions>[3];
export type CardUpdatePositionsResult = Result<typeof CardsServices.updatePositions>;
export type CardRemoveInput = Parameters<typeof CardsServices.remove>[3];
export type CardRemoveResult = Result<typeof CardsServices.remove>;
export type CardRemoveOneResult = Result<typeof CardsServices.removeOne>;
export type CardMoveInput = Parameters<typeof CardsServices.move>[3];
export type CardMoveResult = Result<typeof CardsServices.move>;
export type CardSetLayerInput = Parameters<typeof CardsServices.setLayer>[3];
export type CardSetLayerResult = Result<typeof CardsServices.setLayer>;
export type CardSetPartitionInput = Parameters<typeof CardsServices.setPartition>[3];
export type CardSetPartitionResult = Result<typeof CardsServices.setPartition>;
export type CardSetStackingInput = Parameters<typeof CardsServices.setStacking>[3];
export type CardSetStackingResult = Result<typeof CardsServices.setStacking>;
export type CardSquashInput = Parameters<typeof CardsServices.squash>[3];
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

export type GlueCreateInput = Parameters<typeof GluesServices.create>[3];
export type GlueCreateResult = Result<typeof GluesServices.create>;
export type GlueRemoveInput = Parameters<typeof GluesServices.remove>[3];
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

export type LayerCreateInput = Parameters<typeof LayersServices.create>[3];
export type LayerCreateResult = Result<typeof LayersServices.create>;
export type LayerRenameInput = Parameters<typeof LayersServices.rename>[4];
export type LayerRenameResult = Result<typeof LayersServices.rename>;
export type LayerRemoveResult = Result<typeof LayersServices.remove>;
export type LayerReorderInput = Parameters<typeof LayersServices.reorder>[3];
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

export type PartitionCreateInput = Parameters<typeof PartitionsServices.create>[3];
export type PartitionCreateResult = Result<typeof PartitionsServices.create>;
export type PartitionRenameInput = Parameters<typeof PartitionsServices.rename>[4];
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

export type ScopeCreateInput = Parameters<typeof ScopesServices.create>[2];
export type ScopeCreateResult = Result<typeof ScopesServices.create>;
export type ScopeRenameInput = Parameters<typeof ScopesServices.rename>[4];
export type ScopeRenameResult = Result<typeof ScopesServices.rename>;
export type ScopeRemoveResult = Result<typeof ScopesServices.remove>;
export type ScopeAddMembersInput = Parameters<typeof ScopesServices.addMembers>[4];
export type ScopeAddMembersResult = Result<typeof ScopesServices.addMembers>;
export type ScopeRemoveMembersInput = Parameters<typeof ScopesServices.removeMembers>[4];
export type ScopeRemoveMembersResult = Result<typeof ScopesServices.removeMembers>;
export type ScopeCreateAreaInput = Parameters<typeof ScopesServices.createArea>[4];
export type ScopeCreateAreaResult = Result<typeof ScopesServices.createArea>;
export type ScopeUpdateAreaInput = Parameters<typeof ScopesServices.updateArea>[5];
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

export type WarpCreateInput = Parameters<typeof WarpsServices.create>[3];
export type WarpCreateResult = Result<typeof WarpsServices.create>;
export type WarpUpdateInput = Parameters<typeof WarpsServices.update>[4];
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

export type InventoryCreateInput = Parameters<typeof InventoriesServices.create>[3];
export type InventoryCreateResult = Result<typeof InventoriesServices.create>;
export type InventoryUpdateInput = Parameters<typeof InventoriesServices.update>[4];
export type InventoryUpdateResult = Result<typeof InventoriesServices.update>;
export type InventoryRemoveResult = Result<typeof InventoriesServices.remove>;
export type InventoryStowInput = Parameters<typeof InventoriesServices.stow>[4];
export type InventoryStowResult = Result<typeof InventoriesServices.stow>;
export type InventoryTakeInput = Parameters<typeof InventoriesServices.take>[3];
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

export type NamespaceCreateInput = { name: string };
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
