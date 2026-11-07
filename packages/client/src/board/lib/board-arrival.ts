import type {
  BoardDestination,
  BoardArrivalParameter,
  NavigationAdapter,
} from "../../navigation.js";
import type { CardWithGlue, Inventory, TaskspaceSummary } from "@kozane/core";

/**
 * What a link asked the board to open on arrival: `?card=` names a card, and
 * `?taskspace=&path=` names a taskspace file. `handled` lists the query parameters acted on,
 * which the page removes so reloading does not repeat them.
 */
export type Arrival = {
  card: CardWithGlue | null;
  /** The file to open, or null when none was named or files cannot be opened here. */
  file: { taskspace: TaskspaceSummary; path: string } | null;
  /**
   * The inventory holding `card`, when it is stored. A stored card's own position is where it
   * last sat on the canvas, so the board lands on this inventory's icon and opens its grid.
   */
  inventory: Inventory | null;
  handled: BoardArrivalParameter[];
};

type ArrivalBoard = {
  cards: readonly CardWithGlue[];
  taskspaces: readonly TaskspaceSummary[];
  inventories: readonly Inventory[];
};

/**
 * Read every arrival parameter before any is applied or removed, so asynchronous actions
 * cannot read a partially cleared URL. Names that are not on this board resolve to null.
 *
 * `canOpenFiles` checks whether the backend can read the named taskspace.
 */
export function readArrival(
  destination: BoardDestination,
  board: ArrivalBoard,
  canOpenFiles: boolean | ((taskspace: TaskspaceSummary) => boolean),
): Arrival {
  const cardId = destination.card;
  const card = cardId ? (board.cards.find(({ id }) => id === cardId) ?? null) : null;
  const taskspaceId = destination.taskspace;
  const path = destination.path;
  const taskspace =
    taskspaceId && path && canOpenFiles
      ? (board.taskspaces.find(({ id }) => id === taskspaceId) ?? null)
      : null;

  const allowedTaskspace =
    taskspace && (typeof canOpenFiles === "function" ? canOpenFiles(taskspace) : canOpenFiles)
      ? taskspace
      : null;
  const handled: BoardArrivalParameter[] = [];
  const file = allowedTaskspace && path ? { taskspace: allowedTaskspace, path } : null;
  if (file) handled.push("taskspace", "path");
  if (card) handled.push("card");

  const inventory = card?.inventory
    ? (board.inventories.find(({ id }) => id === card.inventory?.id) ?? null)
    : null;
  return { card, file, inventory, handled };
}

/**
 * The warp named by `?warp=`, which is how a jump to another namespace says where it was
 * headed. Null whenever the id is absent or belongs to a warp this namespace no longer has.
 */
export function arrivalWarp<W extends { id: string }>(
  destination: BoardDestination,
  warps: readonly W[],
): W | null {
  const warpId = destination.warp;
  return warpId ? (warps.find(({ id }) => id === warpId) ?? null) : null;
}

/**
 * Remove arrival parameters after use so reloading does not repeat the jump. Preserve
 * unrelated parameters and ignore router errors during this cosmetic update.
 */
export function clearArrivalParams(
  current: URL,
  names: readonly BoardArrivalParameter[],
  navigation: Pick<NavigationAdapter, "clearBoard">,
  replace: (href: string) => void,
): void {
  try {
    replace(navigation.clearBoard(current, names));
  } catch {
    // Cosmetic URL cleanup must not prevent opening an arrival target.
  }
}
