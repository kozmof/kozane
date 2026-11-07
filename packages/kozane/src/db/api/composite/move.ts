import { records } from "@kozane/core/database";
export const moveCardsToNamespace: typeof records.compositeMove.moveCardsToNamespace =
  records.compositeMove.moveCardsToNamespace;
export const moveCardsToNamespaceInTx: typeof records.compositeMove.moveCardsToNamespaceInTx =
  records.compositeMove.moveCardsToNamespaceInTx;
export type MoveCardsResult = records.compositeMove.MoveCardsResult;
