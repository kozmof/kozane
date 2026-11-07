import { records } from "@kozane/core/database";
export const refitStoredCardInTx: typeof records.inventoryStow.refitStoredCardInTx =
  records.inventoryStow.refitStoredCardInTx;
export const stowCards: typeof records.inventoryStow.stowCards = records.inventoryStow.stowCards;
export const stowCardsInTx: typeof records.inventoryStow.stowCardsInTx =
  records.inventoryStow.stowCardsInTx;
export const takeCards: typeof records.inventoryStow.takeCards = records.inventoryStow.takeCards;
export const takeCardsInTx: typeof records.inventoryStow.takeCardsInTx =
  records.inventoryStow.takeCardsInTx;
export type Refit = records.inventoryStow.Refit;
export type RefitResult = records.inventoryStow.RefitResult;
export type StowResult = records.inventoryStow.StowResult;
export type TakeResult = records.inventoryStow.TakeResult;
