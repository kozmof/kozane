import { css } from "styled-system/css";

/** Buttons in the editor panel's header and notice bars. */
export const barButton = css({
  padding: "3px 9px",
  fontFamily: "inherit",
  fontSize: "11.5px",
  background: "transparent",
  border: "1px solid token(colors.neutral.border)",
  borderRadius: "2px",
  color: "ink.secondary",
  cursor: "pointer",
  "&:hover:not(:disabled)": { backgroundColor: "neutral.bg" },
  "&:disabled": { color: "neutral.disabled", cursor: "default" },
});

/**
 * The pin holds only an icon, shorter than the text buttons' line box. Stretch it to the
 * header row, whose height those buttons set, and center the icon.
 */
export const iconButton = css({
  alignSelf: "stretch",
  display: "inline-flex",
  alignItems: "center",
});
export const pinnedButton = css({ color: "select.accent", borderColor: "select.accent" });
