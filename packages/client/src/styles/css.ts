import { css as generatedCss } from "./generated/css/css.js";
import type { SystemStyleObject } from "./generated/types/system-types.js";
export { cx } from "./generated/css/cx.js";
type Style = SystemStyleObject | undefined | null | false | Style[];
/** Typed entry point for generated Panda runtime assets. */
export function css(...styles: Style[]): string {
  return generatedCss(...styles);
}
