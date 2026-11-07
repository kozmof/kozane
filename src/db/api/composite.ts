import { records } from "@kozane/core/database";
export const deleteNamespaceCards: typeof records.composite.deleteNamespaceCards =
  records.composite.deleteNamespaceCards;
export const deleteNamespaceCardsInTx: typeof records.composite.deleteNamespaceCardsInTx =
  records.composite.deleteNamespaceCardsInTx;
export const squashNamespaceCard: typeof records.composite.squashNamespaceCard =
  records.composite.squashNamespaceCard;
export type SquashCardResult = records.composite.SquashCardResult;
export const moveCardsToNamespace: typeof records.composite.moveCardsToNamespace =
  records.composite.moveCardsToNamespace;
export const moveCardsToNamespaceInTx: typeof records.composite.moveCardsToNamespaceInTx =
  records.composite.moveCardsToNamespaceInTx;
export type MoveCardsResult = records.composite.MoveCardsResult;
export const deletePartitionWithReassign: typeof records.composite.deletePartitionWithReassign =
  records.composite.deletePartitionWithReassign;
export const deleteLayerWithReassign: typeof records.composite.deleteLayerWithReassign =
  records.composite.deleteLayerWithReassign;
