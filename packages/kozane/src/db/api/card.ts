import { records } from "@kozane/core/database";
export const updateNamespaceCardPositionsInTx: typeof records.card.updateNamespaceCardPositionsInTx =
  records.card.updateNamespaceCardPositionsInTx;
export const inventoryColumns: typeof records.card.inventoryColumns = records.card.inventoryColumns;
export const cardInventory: typeof records.card.cardInventory = records.card.cardInventory;
export const withCardInventory: typeof records.card.withCardInventory =
  records.card.withCardInventory;
export const isStored: typeof records.card.isStored = records.card.isStored;
export const onCanvas: typeof records.card.onCanvas = records.card.onCanvas;
export const halfPlaced: typeof records.card.halfPlaced = records.card.halfPlaced;
export const cardsInNamespace: typeof records.card.cardsInNamespace = records.card.cardsInNamespace;
export const cardsBelongToNamespace: typeof records.card.cardsBelongToNamespace =
  records.card.cardsBelongToNamespace;
export const getAllCards: typeof records.card.getAllCards = records.card.getAllCards;
export const getNamespaceCardIds: typeof records.card.getNamespaceCardIds =
  records.card.getNamespaceCardIds;
export const getCardsByPartitions: typeof records.card.getCardsByPartitions =
  records.card.getCardsByPartitions;
export const getCardDataByPartitions: typeof records.card.getCardDataByPartitions =
  records.card.getCardDataByPartitions;
export const getCardMarkersByNamespaces: typeof records.card.getCardMarkersByNamespaces =
  records.card.getCardMarkersByNamespaces;
export const getCard: typeof records.card.getCard = records.card.getCard;
export const defaultLayerIdForPartition: typeof records.card.defaultLayerIdForPartition =
  records.card.defaultLayerIdForPartition;
export const getCardPartitionNames: typeof records.card.getCardPartitionNames =
  records.card.getCardPartitionNames;
export const getCardChangeCounts: typeof records.card.getCardChangeCounts =
  records.card.getCardChangeCounts;
export const getCardLayerNames: typeof records.card.getCardLayerNames =
  records.card.getCardLayerNames;
export type CardMarker = records.card.CardMarker;
export type CardChangeCount = records.card.CardChangeCount;
export const caseUpdateBatches: typeof records.card.caseUpdateBatches =
  records.card.caseUpdateBatches;
export const newCardStamps: typeof records.card.newCardStamps = records.card.newCardStamps;
export const addCard: typeof records.card.addCard = records.card.addCard;
export const addCardInTx: typeof records.card.addCardInTx = records.card.addCardInTx;
export const addCards: typeof records.card.addCards = records.card.addCards;
export const addCardsInTx: typeof records.card.addCardsInTx = records.card.addCardsInTx;
export type AddedCard = records.card.AddedCard;
export const reassignPartitionCards: typeof records.card.reassignPartitionCards =
  records.card.reassignPartitionCards;
export const updateCard: typeof records.card.updateCard = records.card.updateCard;
export const updateCardInTx: typeof records.card.updateCardInTx = records.card.updateCardInTx;
export const updateNamespaceCardPositions: typeof records.card.updateNamespaceCardPositions =
  records.card.updateNamespaceCardPositions;
export const writeCardPositionsInTx: typeof records.card.writeCardPositionsInTx =
  records.card.writeCardPositionsInTx;
export const reassignCardsToPartition: typeof records.card.reassignCardsToPartition =
  records.card.reassignCardsToPartition;
export const reassignCardsToPartitionInTx: typeof records.card.reassignCardsToPartitionInTx =
  records.card.reassignCardsToPartitionInTx;
export type CardPositionUpdate = records.card.CardPositionUpdate;
export type ReassignPartitionResult = records.card.ReassignPartitionResult;
export const nextLayerZIndexInTx: typeof records.card.nextLayerZIndexInTx =
  records.card.nextLayerZIndexInTx;
export const reassignCardsToLayer: typeof records.card.reassignCardsToLayer =
  records.card.reassignCardsToLayer;
export const reassignCardsToLayerInTx: typeof records.card.reassignCardsToLayerInTx =
  records.card.reassignCardsToLayerInTx;
export const reassignCardsStackOrder: typeof records.card.reassignCardsStackOrder =
  records.card.reassignCardsStackOrder;
export type CardStacking = records.card.CardStacking;
export type ReassignLayerResult = records.card.ReassignLayerResult;
export type ReassignStackOrderResult = records.card.ReassignStackOrderResult;
