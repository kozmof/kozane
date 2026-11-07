import type {
  ScopeCreateResult,
  ScopeRenameResult,
  ScopeCreateAreaResult,
  WarpCreateResult,
} from "../../packages/client/src/backend/index.js";
/** Complete service-shaped results used by backend transport and decoder tests. */
export const geometryResults = {
  "scopes.create": { id: "s" } satisfies ScopeCreateResult,
  "scopes.rename": { id: "s", name: "Scope" } satisfies ScopeRenameResult,
  "scopes.remove": { ok: true },
  "scopes.addMembers": { ok: true },
  "scopes.removeMembers": { ok: true },
  "scopes.createArea": {
    id: "a",
    scopeId: "s",
    namespaceId: "n /",
    posX: 1,
    posY: 2,
    width: 100,
    height: 100,
  } satisfies ScopeCreateAreaResult,
  "scopes.updateArea": {
    id: "a",
    scopeId: "s",
    namespaceId: "n /",
    posX: 3,
    posY: 4,
    width: 100,
    height: 100,
  } satisfies ScopeCreateAreaResult,
  "scopes.removeArea": { ok: true },
  "warps.create": { id: "w", namespaceId: "n /", posX: 1, posY: 2 } satisfies WarpCreateResult,
  "warps.update": { id: "w", namespaceId: "n /", posX: 3, posY: 4 } satisfies WarpCreateResult,
  "warps.remove": { ok: true },
};
