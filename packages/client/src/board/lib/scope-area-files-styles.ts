import { css } from "../../styles/css.js";

/** Styles shared by a scope frame's file strip and its cells. */

export const noteClass = css({
  fontSize: "10px",
  lineHeight: "1.3",
  color: "neutral.subtle",
  fontStyle: "italic",
  textAlign: "right",
});

export const cellClass = css({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "3px",
  padding: "3px 2px",
  border: "none",
  borderRadius: "3px",
  background: "transparent",
  color: "neutral.iconDim",
  fontFamily: "inherit",
  textAlign: "center",
});

export const clickableClass = css({
  cursor: "pointer",
  "&:hover": { backgroundColor: "neutral.bg", color: "ink.secondary" },
});

/** The create buttons side by side in the icon line of their cell. */
export const createIconsClass = css({ display: "flex", justifyContent: "center", gap: "2px" });

/**
 * A square around one glyph. The negative margin lets it overhang the cell's padding so the
 * glyph itself lands exactly where a file cell draws its icon.
 */
export const createButtonClass = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "22px",
  height: "22px",
  margin: "-2px 0",
  flexShrink: "0",
  padding: "0",
  border: "none",
  borderRadius: "3px",
  background: "transparent",
  color: "neutral.iconDim",
});

/**
 * Clip names after two lines to preserve row height. Expose the complete name in the cell
 * title.
 */
export const labelClass = css({
  width: "100%",
  fontSize: "9.5px",
  lineHeight: "1.2",
  maxHeight: "23px",
  color: "neutral.secondary",
  overflow: "hidden",
  overflowWrap: "anywhere",
});

/**
 * Stop file-cell presses from starting canvas panning or Shift-drag selection.
 */
export function swallow(event: MouseEvent) {
  event.stopPropagation();
  event.preventDefault();
}
