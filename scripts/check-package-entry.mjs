import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * What the published tarball must and must not carry, for the server to start at all and to
 * start on the right interface.
 *
 * Two invariants, and the second is why this is a script rather than another `grep -c` in
 * `package.json`:
 *
 * 1. **`build/index.js` is excluded.** It is adapter-node's own entry, and it binds
 *    `env('HOST', '0.0.0.0')` — every interface, by default, for a workspace that is one
 *    person's notes. `bin/server.js` replaces it and binds `DEFAULT_SERVER_HOST` instead.
 *    Shipping both leaves the footgun one `node build/index.js` away, so `files` excludes it
 *    with a negation pattern, and a negation pattern is exactly the kind of thing that stops
 *    working quietly when someone reorders the array or adds an entry above it.
 *
 * 2. **The pieces `bin/server.js` needs are present.** Asserting only the absence would pass
 *    just as happily if `build/` were empty, or if `handler.js` were dropped along with it —
 *    a tarball that installs and then cannot serve a request. `handler.js` is what
 *    `bin/server.js` imports; `env.js` and `shims.js` are what *it* imports in turn.
 *
 * Run from `pnpm pack:check`, against the tarball `pack:tmp` leaves in the temp directory.
 */

const packageRoot = resolve(import.meta.dirname, "..");
const { name, version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const tarball = join(process.env.TMPDIR ?? tmpdir(), `${name}-${version}.tgz`);

/** Every path in the tarball, with npm's `package/` prefix stripped. */
function entries() {
  let listing;
  try {
    listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  } catch (error) {
    console.error(`ERROR: could not read ${tarball}. Run 'pnpm pack:tmp' first.`);
    throw error;
  }
  return new Set(
    listing
      .split("\n")
      .map((line) => line.trim().replace(/^package\//, ""))
      .filter(Boolean),
  );
}

/** Present because `bin/server.js` cannot serve a request without them. */
const REQUIRED = [
  "bin/kozane.js",
  "bin/server.js",
  "build/handler.js",
  "build/env.js",
  "build/shims.js",
];

/** Absent because it binds every interface by default. See the note above. */
const FORBIDDEN = ["build/index.js", "build/index.js.map"];

const present = entries();
const missing = REQUIRED.filter((path) => !present.has(path));
const shipped = FORBIDDEN.filter((path) => present.has(path));

if (missing.length > 0) {
  console.error(`ERROR: the tarball is missing files the server needs:\n  ${missing.join("\n  ")}`);
}
if (shipped.length > 0) {
  console.error(
    `ERROR: the tarball ships the Node adapter's own entry, which binds 0.0.0.0 by default:\n  ${shipped.join("\n  ")}\n` +
      `Check the "!build/index.js" negations in the "files" array of package.json.`,
  );
}
if (missing.length > 0 || shipped.length > 0) {
  console.error(`\nTarball: ${tarball}`);
  process.exit(1);
}

console.log(
  `OK: server entry is bin/server.js, adapter entry excluded, ${REQUIRED.length} required files present.`,
);
