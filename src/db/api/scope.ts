import { records } from "@kozane/core/database";
export const getAllScopes: typeof records.scope.getAllScopes = records.scope.getAllScopes;
export const getScopesInNamespace: typeof records.scope.getScopesInNamespace =
  records.scope.getScopesInNamespace;
export const getScopeNamespaceUsage: typeof records.scope.getScopeNamespaceUsage =
  records.scope.getScopeNamespaceUsage;
export const getScopePartitionUsage: typeof records.scope.getScopePartitionUsage =
  records.scope.getScopePartitionUsage;
export const getScope: typeof records.scope.getScope = records.scope.getScope;
export const addScope: typeof records.scope.addScope = records.scope.addScope;
export const updateScopeName: typeof records.scope.updateScopeName = records.scope.updateScopeName;
export const deleteScope: typeof records.scope.deleteScope = records.scope.deleteScope;
export const deleteScopeFromNamespace: typeof records.scope.deleteScopeFromNamespace =
  records.scope.deleteScopeFromNamespace;
export type ScopeNamespaceUsage = records.scope.ScopeNamespaceUsage;
export type ScopePartitionUsage = records.scope.ScopePartitionUsage;
