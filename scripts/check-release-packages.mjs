import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const root = read("package.json");
const core = read("packages/core/package.json");
const client = read("packages/client/package.json");
const cli = read("packages/kozane/package.json");
const config = read(".changeset/config.json");
assert.equal(root.private, true);
assert.equal(config.access, "public");
assert.equal(config.baseBranch, "main");
assert.deepEqual(config.ignore, []);
assert.deepEqual(config.privatePackages, { version: false, tag: false });
assert.equal(config.bumpVersionsWithWorkspaceProtocolOnly, false);
for (const pkg of [core, client, cli]) {
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.publishConfig.access, "public");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.repository.url, root.repository.url);
}
assert.equal(core.name, "@kozane/core");
assert.equal(client.name, "@kozane/client");
assert.equal(cli.name, "kozane");
assert.equal(client.peerDependencies[core.name], core.version);
assert.equal(client.devDependencies[core.name], `workspace:${core.version}`);
assert.equal(client.dependencies[core.name], undefined);
assert.equal(cli.dependencies[core.name], `workspace:${core.version}`);
assert.equal(cli.dependencies[client.name], `workspace:${client.version}`);
assert.equal(root.dependencies[core.name], `workspace:${core.version}`);
assert.equal(root.dependencies[client.name], `workspace:${client.version}`);
assert.equal(cli.bin.kozane, "./bin/kozane.js");
assert.equal(root.scripts["publish:npm"], "pnpm -r publish --access public --provenance");
console.log(
  `Release order: ${core.name}@${core.version}, ${client.name}@${client.version}, ${cli.name}@${cli.version}. Exact runtime and peer versions agree.`,
);
