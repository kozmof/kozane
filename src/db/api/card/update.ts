import { records } from "@kozane/core/database";
export const reassignPartitionCards: typeof records.cardUpdate.reassignPartitionCards =
  records.cardUpdate.reassignPartitionCards;
export const updateCard: typeof records.cardUpdate.updateCard = records.cardUpdate.updateCard;
export const updateCardInTx: typeof records.cardUpdate.updateCardInTx =
  records.cardUpdate.updateCardInTx;
export const updateNamespaceCardPositions: typeof records.cardUpdate.updateNamespaceCardPositions =
  records.cardUpdate.updateNamespaceCardPositions;
export const updateNamespaceCardPositionsInTx: typeof records.cardUpdate.updateNamespaceCardPositionsInTx =
  records.cardUpdate.updateNamespaceCardPositionsInTx;
export const writeCardPositionsInTx: typeof records.cardUpdate.writeCardPositionsInTx =
  records.cardUpdate.writeCardPositionsInTx;
export const reassignCardsToPartition: typeof records.cardUpdate.reassignCardsToPartition =
  records.cardUpdate.reassignCardsToPartition;
export const reassignCardsToPartitionInTx: typeof records.cardUpdate.reassignCardsToPartitionInTx =
  records.cardUpdate.reassignCardsToPartitionInTx;
export type CardPositionUpdate = records.cardUpdate.CardPositionUpdate;
export type ReassignPartitionResult = records.cardUpdate.ReassignPartitionResult;
