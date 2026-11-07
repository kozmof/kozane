import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const layers = ["reset", "base", "tokens", "recipes", "utilities"];
/** @param {string} css */
function layerHeader(css) {
  const match = css.match(/^\s*@layer\s+([\w\s,]+);/);
  assert.ok(match, "Shared CSS needs an explicit layer order");
  assert.deepEqual(
    match[1].split(",").map((layer) => layer.trim()),
    layers,
    "Shared CSS layer order changed",
  );
  return match[0].length;
}
/** Preserve one layer declaration followed by base rules and compiled utilities.
 * @param {string} base
 * @param {string} generated
 */
export function combineStyles(base, generated) {
  return `@layer ${layers.join(", ")};\n\n${base.slice(layerHeader(base)).trim()}\n\n${generated.slice(layerHeader(generated)).trim()}\n`;
}
/** @param {string} root @param {string} packageRoot @param {string[]} args */
export function runPanda(root, packageRoot, args) {
  execFileSync(
    "pnpm",
    ["exec", "panda", ...args, "--cwd", root, "--config", join(packageRoot, "panda.config.ts")],
    { cwd: packageRoot, stdio: "inherit", env: { ...process.env, CI: "true" } },
  );
}
/** @param {string} root @param {string} packageRoot */
export async function buildStyles(root, packageRoot) {
  const utilities = join(packageRoot, "tmp/utilities.css");
  runPanda(root, packageRoot, ["cssgen", "src/lib/**/*.{js,ts,svelte}", "--outfile", utilities]);
  const stylesheet = combineStyles(
    await readFile(join(root, "src/app.css"), "utf8"),
    await readFile(utilities, "utf8"),
  );
  await writeFile(join(packageRoot, "dist/styles.css"), stylesheet);
}
