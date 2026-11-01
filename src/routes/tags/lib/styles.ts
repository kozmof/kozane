import { css } from "styled-system/css";

/** Styles shared by the tag index page and its result list. */

export const rowClass = css({
  display: "flex",
  alignItems: "baseline",
  gap: "8px",
  padding: "3px 8px",
  borderRadius: "2px",
  color: "ink.black",
  textDecoration: "none",
  fontSize: "13px",
  _hover: { backgroundColor: "neutral.bg" },
});
export const activeRowClass = css({ backgroundColor: "neutral.bg", fontWeight: "600" });
export const countClass = css({ fontSize: "10.5px", color: "neutral.subtle", fontFamily: "mono" });
/** Taskspace heading that identifies the base directory for relative file paths. */
export const taskspaceHeadingClass = css({
  fontSize: "11px",
  fontWeight: "400",
  fontFamily: "mono",
  color: "neutral.muted",
  marginBottom: "6px",
});
/**
 * Render card text and matching file excerpts as primary content, with quieter surrounding
 * metadata.
 */
export const excerptClass = css({
  fontSize: "12.5px",
  color: "ink.black",
  fontFamily: "mono",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
});

/**
 * Use consistent secondary styling for card truncation, partial taskspace scans, and
 * unavailable taskspaces.
 */
export const noteClass = css({ fontSize: "12px", color: "neutral.subtle", marginTop: "8px" });

/**
 * Apply link styling only to rows with destinations. Render rows without a board as plain
 * elements so hover and pointer cues do not imply an unavailable action.
 */
export const linkableRowClass = css({
  textDecoration: "none",
  transition: "border-color 0.1s",
  _hover: { borderColor: "neutral.muted" },
});
const rowSurface = {
  background: "ink.white",
  border: "1px solid token(colors.neutral.border)",
  borderRadius: "2px",
} as const;
export const cardRowClass = css({ ...rowSurface, display: "block", padding: "10px 14px" });
export const fileRowClass = css({
  ...rowSurface,
  display: "flex",
  gap: "12px",
  alignItems: "baseline",
  padding: "6px 14px",
});
