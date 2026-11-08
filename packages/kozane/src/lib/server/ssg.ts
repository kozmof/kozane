/**
 * Read static-export flags set by `kozane net ssg generate`. Keep environment access in
 * server code and read on each call to avoid dependence on module initialization order.
 *
 * `svelte.config.js` checks the flag separately because adapter selection runs before this
 * module is compiled.
 */
export function isSsgBuild(): boolean {
  return process.env.KOZANE_SSG === "1";
}

/**
 * Whether static export includes scopes, taskspace names, and scoped file copies. Return
 * false outside an export, where live endpoints supply files.
 */
export function ssgIncludesScopedFiles(): boolean {
  return process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES === "1";
}
