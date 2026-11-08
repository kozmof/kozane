import { records } from "@kozane/core/database";
export const repairInventories: typeof records.inventoryRepair.repairInventories =
  records.inventoryRepair.repairInventories;
export const repairInventoriesInTx: typeof records.inventoryRepair.repairInventoriesInTx =
  records.inventoryRepair.repairInventoriesInTx;
export const findInventoryConflicts: typeof records.inventoryRepair.findInventoryConflicts =
  records.inventoryRepair.findInventoryConflicts;
export type InventoryRepair = records.inventoryRepair.InventoryRepair;
export type InventoryConflicts = records.inventoryRepair.InventoryConflicts;
