/** Warp and inventory commands. */
import { Command } from "commander";

import { warpAdd, warpDelete, warpList } from "../commands/warp.js";
import {
  inventoryAdd,
  inventoryDelete,
  inventoryList,
  inventoryPut,
  inventoryRename,
  inventoryRepair,
  inventoryShow,
  inventoryTake,
} from "../commands/inventory.js";
import { integer, nonNegativeInteger } from "./parsers.js";

export function registerBoardCommands(program: Command): void {
  const warp = program.command("warp").description("Warp management");

  warp
    .command("list")
    .description("List a namespace's warps")
    .option("--namespace <namespaceId>", "Namespace ID or short ID whose warps to list")
    .action((opts) => warpList(opts));

  warp
    .command("add")
    .description("Add a warp at an X/Y position")
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the warp to")
    .requiredOption("--x <number>", "Horizontal warp position", integer)
    .requiredOption("--y <number>", "Vertical warp position", integer)
    .action((opts) => warpAdd(opts));

  warp
    .command("delete <warpId>")
    .description("Delete a warp by ID or short ID")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the warp belongs to")
    .action((id, opts) => warpDelete(id, opts));

  const inventory = program.command("inventory").description("Inventory management");

  inventory
    .command("list")
    .description("List a namespace's inventories with their card counts")
    .option("--namespace <namespaceId>", "Namespace ID or short ID whose inventories to list")
    .action((opts) => inventoryList(opts));

  inventory
    .command("add")
    .description("Add an inventory at an X/Y position")
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the inventory to")
    .option("--name <name>", "Inventory name")
    .requiredOption("--x <number>", "Horizontal icon position", integer)
    .requiredOption("--y <number>", "Vertical icon position", integer)
    .action((opts) => inventoryAdd(opts));

  inventory
    .command("show <inventoryId>")
    .description("List the cards in an inventory by slot")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the inventory belongs to")
    .action((id, opts) => inventoryShow(id, opts));

  inventory
    .command("rename <inventoryId> <name>")
    .description("Rename an inventory. An empty name leaves it unnamed")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the inventory belongs to")
    .action((id, name, opts) => inventoryRename(id, name, opts));

  inventory
    .command("delete <inventoryId>")
    .description("Delete an inventory and return its cards to the canvas")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the inventory belongs to")
    .action((id, opts) => inventoryDelete(id, opts));

  inventory
    .command("put <inventoryId> <cardIds...>")
    .description("Store cards in an inventory, filling free slots in order")
    .option("--slot <number>", "Slot to start from, counted from 0", nonNegativeInteger)
    .action((id, cardIds, opts) => inventoryPut(id, cardIds, opts));

  inventory
    .command("take <cardIds...>")
    .description("Return stored cards to the canvas where they were before")
    .option("--x <number>", "Horizontal position for a single card", integer)
    .option("--y <number>", "Vertical position for a single card", integer)
    .action((cardIds, opts) => inventoryTake(cardIds, opts));

  inventory
    .command("repair")
    .description("Move overlapping stored cards apart and unglue stored cards, workspace-wide")
    .action(() => inventoryRepair());
}
