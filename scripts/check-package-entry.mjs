import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Check that the published package contains a usable server with the intended default binding.
 *
 * 1. Exclude adapter-node's `build/index.js`, which defaults to binding all interfaces. Kozane
 * uses `bin/server.js` and `DEFAULT_SERVER_HOST` instead.
 * 2. Include `build/handler.js`, `build/env.js`, and `build/shims.js`, which the server
 * needs to start.
 *
 * `pnpm pack:check` runs this against the tarball produced by `pack:tmp`.
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
