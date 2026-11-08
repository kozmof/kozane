/** Option shapes shared by the card subcommands, and the board grid they place cards on. */
import { type CardSortKey } from "../../lib/card-sort.js";

/** The board grid used by card movement and vertical-list placement in the browser. */
export const GRID = 24;

export type CardOptions = {
  namespace?: string;
  partition?: string;
  taskspace?: string;
  sort?: CardSortKey;
  reverse?: boolean;
};

export type CardAddOptions = Omit<CardOptions, "taskspace"> & {
  scope?: string;
  layer?: string;
  x?: number;
  y?: number;
};

export type CardSquashOptions = CardAddOptions & { pattern?: string };

export type CardShowOptions = { times?: boolean };

export type CardGlueOptions = { add?: boolean; alignList?: boolean };

export type CardMoveOptions = { x?: number | string; y?: number | string };
