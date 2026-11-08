/** Active-layer preferences are view state, separate from workspace data and recovery copies. */
export interface PreferenceStorage {
  /** Changes when preferences must be reapplied from the current database defaults. */
  readonly generation: number;
  readActiveLayer(namespaceId: string): string | null;
  writeActiveLayer(namespaceId: string, layerId: string | null): void;
}
type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const ACTIVE_LAYER_STORAGE_PREFIX = "kozane:active-layer:";

/** Retain the Node app and existing SSG export's per-tab preference keys. */
export function createSessionPreferences(
  storage: () => TabStorage | undefined = () => globalThis.sessionStorage,
): PreferenceStorage {
  return Object.freeze({
    generation: 0,
    readActiveLayer(namespaceId: string) {
      try {
        return storage()?.getItem(ACTIVE_LAYER_STORAGE_PREFIX + namespaceId) ?? null;
      } catch {
        return null;
      }
    },
    writeActiveLayer(namespaceId: string, layerId: string | null) {
      try {
        const key = ACTIVE_LAYER_STORAGE_PREFIX + namespaceId;
        if (layerId) storage()?.setItem(key, layerId);
        else storage()?.removeItem(key);
      } catch {
        // A preference failure must not block the board.
      }
    },
  });
}

/** Keep demo preferences in memory for one active client generation. Never access storage. */
export function createMemoryPreferences(generation: () => number = () => 0): PreferenceStorage {
  let current: number | undefined;
  const layers = new Map<string, string>();
  const synchronize = () => {
    const next = generation();
    if (next !== current) {
      layers.clear();
      current = next;
    }
    return next;
  };
  return Object.freeze({
    get generation() {
      return synchronize();
    },
    readActiveLayer(namespaceId: string) {
      synchronize();
      return layers.get(namespaceId) ?? null;
    },
    writeActiveLayer(namespaceId: string, layerId: string | null) {
      synchronize();
      if (layerId) layers.set(namespaceId, layerId);
      else layers.delete(namespaceId);
    },
  });
}

/** Compatibility entry points for existing Node callers. Shared state uses an injected adapter. */
export function readStoredLayerId(namespaceId: string): string | null {
  return createSessionPreferences().readActiveLayer(namespaceId);
}
export function storeActiveLayerId(namespaceId: string, layerId: string | null): void {
  createSessionPreferences().writeActiveLayer(namespaceId, layerId);
}
