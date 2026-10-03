/**
 * Whether this process is building the static export, and what the export was asked to
 * include.
 *
 * `KOZANE_SSG` and `KOZANE_SSG_INCLUDE_SCOPED_FILES` are set by `kozane net ssg generate`
 * when it spawns the build (see `cli/commands/ssg.ts`), and read in nine places: the
 * request gate in `hooks.server.ts`, four `prerender` exports, `trailingSlash`, and the
 * three page loads that decide whether to bake taskspace files in. Every one of them spelled
 * `process.env.KOZANE_SSG === "1"` itself — a comparison against a literal, repeated, where
 * a typo in the name reads as "not an export" and quietly leaves auth enabled during a
 * prerender pass or ships a build with `prerender` off.
 *
 * So the two questions get names. Under `lib/server` rather than beside the isomorphic
 * modules a directory up, for the reason `taskspace-path.ts` gives: it reads `process.env`,
 * so nothing here can be bundled for a browser, and the directory is what says so. It
 * imports nothing, which keeps it reachable from every server-side caller — the hook, the
 * route loads — without pulling a tier along with it.
 *
 * `svelte.config.js` keeps its own copy of the check, because it chooses the adapter before
 * any of this is compiled and cannot import from here.
 *
 * Read on each call rather than captured at module load. The values are fixed for the life
 * of a build, but `prerender` and `trailingSlash` are module-scope *exports* evaluated as
 * their modules load, and a cached constant here would be bound at whatever point this
 * module happened to be pulled in first — which is a thing SvelteKit decides, not this
 * project. A `process.env` read is not worth caching to find out.
 */
export function isSsgBuild(): boolean {
  return process.env.KOZANE_SSG === "1";
}

/**
 * Whether the static export bakes in scopes, taskspace names and a browsable copy of each
 * scoped taskspace's files — `kozane net ssg generate --include-scoped-files`.
 *
 * False outside an export too, which is what the three page loads want: a live board lists
 * files from an endpoint rather than from page data, so there is nothing for this to turn on.
 */
export function ssgIncludesScopedFiles(): boolean {
  return process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES === "1";
}
