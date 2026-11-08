import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { inspectCoreGraph } from "./core-graph.mjs";
const root = process.cwd();
const graph = inspectCoreGraph(root, JSON.parse(process.argv[2]));
// The explicit flag makes the second resolve argument use the actual importer location.
assert.ok(process.execArgv.includes("--experimental-import-meta-resolve"));
const appEntry = import.meta.resolve(
  "@kozane/core",
  pathToFileURL(join(root, "package.json")).href,
);
const clientEntry = import.meta.resolve(
  "@kozane/core",
  pathToFileURL(join(graph.client, "package.json")).href,
);
assert.equal(appEntry, clientEntry, "Node resolves different public core entries");
assert.equal(await import(appEntry), await import(clientEntry), "Core module instances differ");
const { verifyCoreIdentity } = await import("./verify-core-identity.mjs");
await verifyCoreIdentity();
console.log(
  "Packed runtime graph and public core error identity passed with one expected core instance.",
);
