import { records } from "@kozane/core/database";
export const releaseCardsInTx: typeof records.inventory.releaseCardsInTx =
  records.inventory.releaseCardsInTx;
export const getAllInventories: typeof records.inventory.getAllInventories =
  records.inventory.getAllInventories;
export const getInventoryCards: typeof records.inventory.getInventoryCards =
  records.inventory.getInventoryCards;
export const getInventoryCardCounts: typeof records.inventory.getInventoryCardCounts =
  records.inventory.getInventoryCardCounts;
export const addInventory: typeof records.inventory.addInventory = records.inventory.addInventory;
export const addSquashInventoryInTx: typeof records.inventory.addSquashInventoryInTx =
  records.inventory.addSquashInventoryInTx;
export const updateInventory: typeof records.inventory.updateInventory =
  records.inventory.updateInventory;
export const deleteInventory: typeof records.inventory.deleteInventory =
  records.inventory.deleteInventory;
export const deleteInventoryInTx: typeof records.inventory.deleteInventoryInTx =
  records.inventory.deleteInventoryInTx;
export type StoredCard = records.inventory.StoredCard;
export const repairInventories: typeof records.inventory.repairInventories =
  records.inventory.repairInventories;
export const repairInventoriesInTx: typeof records.inventory.repairInventoriesInTx =
  records.inventory.repairInventoriesInTx;
export const findInventoryConflicts: typeof records.inventory.findInventoryConflicts =
  records.inventory.findInventoryConflicts;
export type InventoryRepair = records.inventory.InventoryRepair;
export type InventoryConflicts = records.inventory.InventoryConflicts;
export const refitStoredCardInTx: typeof records.inventory.refitStoredCardInTx =
  records.inventory.refitStoredCardInTx;
export const stowCards: typeof records.inventory.stowCards = records.inventory.stowCards;
export const stowCardsInTx: typeof records.inventory.stowCardsInTx =
  records.inventory.stowCardsInTx;
export const takeCards: typeof records.inventory.takeCards = records.inventory.takeCards;
export const takeCardsInTx: typeof records.inventory.takeCardsInTx =
  records.inventory.takeCardsInTx;
export type Refit = records.inventory.Refit;
export type RefitResult = records.inventory.RefitResult;
export type StowResult = records.inventory.StowResult;
export type TakeResult = records.inventory.TakeResult;
