import { records } from "@kozane/core/database";
export const getAllInventories: typeof records.inventoryRows.getAllInventories =
  records.inventoryRows.getAllInventories;
export const getInventoryCards: typeof records.inventoryRows.getInventoryCards =
  records.inventoryRows.getInventoryCards;
export const getInventoryCardCounts: typeof records.inventoryRows.getInventoryCardCounts =
  records.inventoryRows.getInventoryCardCounts;
export const addInventory: typeof records.inventoryRows.addInventory =
  records.inventoryRows.addInventory;
export const addSquashInventoryInTx: typeof records.inventoryRows.addSquashInventoryInTx =
  records.inventoryRows.addSquashInventoryInTx;
export const updateInventory: typeof records.inventoryRows.updateInventory =
  records.inventoryRows.updateInventory;
export const deleteInventory: typeof records.inventoryRows.deleteInventory =
  records.inventoryRows.deleteInventory;
export const deleteInventoryInTx: typeof records.inventoryRows.deleteInventoryInTx =
  records.inventoryRows.deleteInventoryInTx;
export type StoredCard = records.inventoryRows.StoredCard;
