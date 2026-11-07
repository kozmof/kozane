import { records } from "@kozane/core/database";
export const nextLayerZIndexInTx: typeof records.cardStacking.nextLayerZIndexInTx =
  records.cardStacking.nextLayerZIndexInTx;
export const reassignCardsToLayer: typeof records.cardStacking.reassignCardsToLayer =
  records.cardStacking.reassignCardsToLayer;
export const reassignCardsToLayerInTx: typeof records.cardStacking.reassignCardsToLayerInTx =
  records.cardStacking.reassignCardsToLayerInTx;
export const reassignCardsStackOrder: typeof records.cardStacking.reassignCardsStackOrder =
  records.cardStacking.reassignCardsStackOrder;
export type CardStacking = records.cardStacking.CardStacking;
export type ReassignLayerResult = records.cardStacking.ReassignLayerResult;
export type ReassignStackOrderResult = records.cardStacking.ReassignStackOrderResult;
