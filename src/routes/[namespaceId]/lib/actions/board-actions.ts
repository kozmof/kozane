import * as api from "../namespace-api.js";
import type { NamespaceState } from "../../namespace-state.svelte.js";
import { readFiniteNumber, readString } from "../response.js";
import { readStacking } from "./shared.js";

/** Board structure actions: partitions, layers, and warps. */
export function createBoardActions(state: NamespaceState) {
  async function handleCreatePartition() {
    const name = state.sidebar.newPartitionName.trim();
    if (!name) return;
    const res = await api.createPartition(state.mutationFetcher, state.namespaceId, name);
    if (!res.ok) {
      state.setError("Failed to create partition");
      return;
    }
    const id = readString(await res.json().catch(() => null), "id");
    if (id === undefined) {
      state.setError("Failed to create partition");
      return;
    }
    state.partitions = [
      ...state.partitions,
      { id, namespaceId: state.namespaceId, name, isDefault: false },
    ];
    state.sidebar.newPartitionName = "";
  }

  async function handleDeletePartition(partitionId: string) {
    const res = await api.deletePartition(state.mutationFetcher, state.namespaceId, partitionId);
    if (!res.ok) {
      state.setError("Failed to delete partition");
      return;
    }
    const defaultPartitionId = readString(await res.json().catch(() => null), "defaultPartitionId");
    if (defaultPartitionId === undefined) {
      state.setError("Failed to delete partition");
      return;
    }
    state.cards = state.cards.map((c) =>
      c.partitionId === partitionId ? { ...c, partitionId: defaultPartitionId } : c,
    );
    state.partitions = state.partitions.filter((b) => b.id !== partitionId);
    if (state.sidebar.activePartition === partitionId) state.sidebar.activePartition = null;
  }

  async function handleCreateLayer(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api.createLayer(state.mutationFetcher, state.namespaceId, trimmed);
    if (!res.ok) {
      // The server's own wording carries the reason a name was refused ("A layer named
      // 'Draft' already exists"), which a fixed banner would throw away.
      state.setError(await api.failureMessage(res, "Failed to create layer"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    const id = readString(parsed, "id");
    const position = readFiniteNumber(parsed, "position");
    if (id === undefined || position === undefined) {
      state.setError("Failed to create layer");
      return;
    }
    state.layers = [
      ...state.layers,
      { id, namespaceId: state.namespaceId, name: trimmed, position, isDefault: false },
    ];
    // A layer is created to be drawn on, so it becomes the one new cards land on.
    state.activeLayerId = id;
  }

  async function handleDeleteLayer(layerId: string) {
    const res = await api.deleteLayer(state.mutationFetcher, state.namespaceId, layerId);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to delete layer"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    const defaultLayerId = readString(parsed, "defaultLayerId");
    if (defaultLayerId === undefined) {
      state.setError("Failed to delete layer");
      return;
    }
    // The server restacks the moved cards above the default layer's cards.
    const stacking = readStacking(parsed);
    state.cards = state.cards.map((c) =>
      c.layerId === layerId
        ? { ...c, layerId: defaultLayerId, zIndex: stacking.get(c.id) ?? c.zIndex }
        : c,
    );
    state.layers = state.layers.filter((l) => l.id !== layerId);
    if (state.activeLayerId === layerId) state.activeLayerId = defaultLayerId;
  }

  async function handleSetWarp(position: { posX: number; posY: number }) {
    const res = await api.createWarp(state.mutationFetcher, state.namespaceId, position);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to set warp"));
      return;
    }
    // Use the stored warp position because the server clamps it to the canvas.
    const parsed = api.parseWarp(await res.json().catch(() => null));
    if (!parsed) {
      state.setError("Failed to set warp");
      return;
    }
    state.warps = [...state.warps, parsed];
    state.focusedWarpId = parsed.id;
  }

  async function handleRemoveWarp(warpId: string) {
    const prevWarps = state.warps;
    const prevFocused = state.focusedWarpId;
    state.warps = state.warps.filter((w) => w.id !== warpId);
    if (state.focusedWarpId === warpId) state.focusedWarpId = null;
    const res = await api.deleteWarp(state.mutationFetcher, state.namespaceId, warpId);
    if (!res.ok) {
      state.warps = prevWarps;
      state.focusedWarpId = prevFocused;
      state.setError(await api.failureMessage(res, "Failed to remove warp"));
    }
  }

  async function handleRenameLayer(layerId: string, name: string) {
    const trimmed = name.trim();
    const layer = state.layers.find((l) => l.id === layerId);
    if (!trimmed || !layer || layer.name === trimmed) return;
    const prevLayers = state.layers;
    state.layers = state.layers.map((l) => (l.id === layerId ? { ...l, name: trimmed } : l));
    const res = await api.renameLayer(state.mutationFetcher, state.namespaceId, layerId, trimmed);
    if (!res.ok) {
      state.layers = prevLayers;
      state.setError(await api.failureMessage(res, "Failed to rename layer"));
    }
  }

  /** `layerIds` is the namespace's full layer ordering, bottom to top. */
  async function handleReorderLayers(layerIds: string[]) {
    const prevLayers = state.layers;
    const byId = new Map(prevLayers.map((l) => [l.id, l]));
    if (layerIds.length !== prevLayers.length || layerIds.some((id) => !byId.has(id))) return;
    state.layers = layerIds.map((id, position) => ({ ...byId.get(id)!, position }));
    const res = await api.reorderLayers(state.mutationFetcher, state.namespaceId, layerIds);
    if (!res.ok) {
      state.layers = prevLayers;
      // Show the server's reorder guidance when layers changed elsewhere.
      state.setError(await api.failureMessage(res, "Failed to reorder layers"));
    }
  }

  return {
    handleCreatePartition,
    handleDeletePartition,
    handleCreateLayer,
    handleDeleteLayer,
    handleSetWarp,
    handleRemoveWarp,
    handleRenameLayer,
    handleReorderLayers,
  };
}
