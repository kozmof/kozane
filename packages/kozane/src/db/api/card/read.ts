import { records } from "@kozane/core/database";
export const cardsInNamespace: typeof records.cardRead.cardsInNamespace =
  records.cardRead.cardsInNamespace;
export const cardsBelongToNamespace: typeof records.cardRead.cardsBelongToNamespace =
  records.cardRead.cardsBelongToNamespace;
export const getAllCards: typeof records.cardRead.getAllCards = records.cardRead.getAllCards;
export const getNamespaceCardIds: typeof records.cardRead.getNamespaceCardIds =
  records.cardRead.getNamespaceCardIds;
export const getCardsByPartitions: typeof records.cardRead.getCardsByPartitions =
  records.cardRead.getCardsByPartitions;
export const getCardDataByPartitions: typeof records.cardRead.getCardDataByPartitions =
  records.cardRead.getCardDataByPartitions;
export const getCardMarkersByNamespaces: typeof records.cardRead.getCardMarkersByNamespaces =
  records.cardRead.getCardMarkersByNamespaces;
export const getCard: typeof records.cardRead.getCard = records.cardRead.getCard;
export const defaultLayerIdForPartition: typeof records.cardRead.defaultLayerIdForPartition =
  records.cardRead.defaultLayerIdForPartition;
export const getCardPartitionNames: typeof records.cardRead.getCardPartitionNames =
  records.cardRead.getCardPartitionNames;
export const getCardChangeCounts: typeof records.cardRead.getCardChangeCounts =
  records.cardRead.getCardChangeCounts;
export const getCardLayerNames: typeof records.cardRead.getCardLayerNames =
  records.cardRead.getCardLayerNames;
export type CardMarker = records.cardRead.CardMarker;
export type CardChangeCount = records.cardRead.CardChangeCount;
