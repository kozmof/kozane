import { records } from "@kozane/core/database";
export const getAllCardsByScope: typeof records.scopeRel.getAllCardsByScope =
  records.scopeRel.getAllCardsByScope;
export const getCardsByScopeWithPartitionName: typeof records.scopeRel.getCardsByScopeWithPartitionName =
  records.scopeRel.getCardsByScopeWithPartitionName;
export const addScopeRel: typeof records.scopeRel.addScopeRel = records.scopeRel.addScopeRel;
export const removeScopeRel: typeof records.scopeRel.removeScopeRel =
  records.scopeRel.removeScopeRel;
export const addScopeRels: typeof records.scopeRel.addScopeRels = records.scopeRel.addScopeRels;
export const addScopeMembers: typeof records.scopeRel.addScopeMembers =
  records.scopeRel.addScopeMembers;
export const addScopeMembersInTx: typeof records.scopeRel.addScopeMembersInTx =
  records.scopeRel.addScopeMembersInTx;
export const removeScopeMembers: typeof records.scopeRel.removeScopeMembers =
  records.scopeRel.removeScopeMembers;
export const removeScopeMembersFromNamespace: typeof records.scopeRel.removeScopeMembersFromNamespace =
  records.scopeRel.removeScopeMembersFromNamespace;
export const removeScopeMembersFromNamespaceInTx: typeof records.scopeRel.removeScopeMembersFromNamespaceInTx =
  records.scopeRel.removeScopeMembersFromNamespaceInTx;
export const getScopeRelsByCards: typeof records.scopeRel.getScopeRelsByCards =
  records.scopeRel.getScopeRelsByCards;
export const getScopeRelsByNamespace: typeof records.scopeRel.getScopeRelsByNamespace =
  records.scopeRel.getScopeRelsByNamespace;
export type CardWithPartitionName = records.scopeRel.CardWithPartitionName;
export type ScopeMemberResult = records.scopeRel.ScopeMemberResult;
