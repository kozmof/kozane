import { records } from "@kozane/core/database";
export const newCardStamps: typeof records.cardCreate.newCardStamps =
  records.cardCreate.newCardStamps;
export const addCard: typeof records.cardCreate.addCard = records.cardCreate.addCard;
export const addCardInTx: typeof records.cardCreate.addCardInTx = records.cardCreate.addCardInTx;
export const addCards: typeof records.cardCreate.addCards = records.cardCreate.addCards;
export const addCardsInTx: typeof records.cardCreate.addCardsInTx = records.cardCreate.addCardsInTx;
export type AddedCard = records.cardCreate.AddedCard;
