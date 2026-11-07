import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
const domains = new Set([
  "card",
  "inventory",
  "layer",
  "namespace",
  "partition",
  "scope",
  "tag",
  "warp",
]);
export function classifyAdapter(path) {
  const command = path.match(/\/cli\/commands\/([^/.]+)/)?.[1];
  if (command)
    return domains.has(command)
      ? "core-backed"
      : ["init", "db", "open", "status"].includes(command)
        ? "infrastructure"
        : "Node feature";
  if (/\/health\//.test(path)) return "infrastructure";
  if (/\/(login|taskspaces)\//.test(path)) return "Node feature";
  return "core-backed";
}
export function auditAdapters() {
  const adapters = files(join(root, "packages/kozane/src")).filter(
    (file) =>
      /(?:routes\/.*\+(?:server|page\.server|layout\.server)|cli\/commands\/.*)\.ts$/.test(file) &&
      !/\.test\.ts$/.test(file),
  );
  const results = [];
  for (const file of adapters.sort()) {
    const path = relative(root, file);
    const source = readFileSync(file, "utf8");
    const classification = classifyAdapter(path);
    if (classification === "core-backed") {
      // Adapter-only reads resolve CLI identifiers and shape output. Domain writes must delegate.
      assert.doesNotMatch(
        source,
        /\b(?:db|tx)\s*\.\s*(?:insert|update|delete|run|execute|transaction)\s*\(/,
        `Direct domain write in ${path}`,
      );
      assert.doesNotMatch(source, /\bwithTx\s*\(/, `Use core composition in ${path}`);
    }
    results.push({
      path,
      classification,
      responsibility:
        classification === "core-backed"
          ? /composeWrite/.test(source)
            ? "References and mutation share core composition"
            : "Core services/records, read projections or transport composition"
          : classification === "Node feature"
            ? "Filesystem, authentication or configuration policy stays in Node"
            : "Workspace lifecycle, migration, diagnostics or health",
    });
  }
  return results;
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  console.log(
    `Adapter boundary audit passed for ${auditAdapters().length} route, loader and CLI modules.`,
  );
}
