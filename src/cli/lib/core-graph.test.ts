import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectCoreGraph } from "../../../scripts/client-package/core-graph.mjs";
const roots: string[] = [];
const versions = { core: "0.1.0", client: "0.1.0" };
function write(root: string, pkg: Record<string, unknown>) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kozane-core-graph-"));
  roots.push(root);
  write(root, {
    name: "consumer",
    dependencies: { "@kozane/core": "0.1.0", "@kozane/client": "0.1.0" },
  });
  const core = join(root, "node_modules/@kozane/core");
  const client = join(root, "node_modules/@kozane/client");
  write(core, { name: "@kozane/core", version: "0.1.0" });
  write(client, {
    name: "@kozane/client",
    version: "0.1.0",
    peerDependencies: { "@kozane/core": "0.1.0" },
  });
  return { root, core, client };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("installed core runtime graph", () => {
  it("accepts one physical instance reached through several symlinks", () => {
    const { root, core, client } = fixture();
    mkdirSync(join(client, "node_modules/@kozane"), { recursive: true });
    symlinkSync(core, join(client, "node_modules/@kozane/core"), "dir");
    expect(inspectCoreGraph(root, versions).core).toBe(core);
  });
  it("requires direct application dependencies", () => {
    const { root } = fixture();
    write(root, { dependencies: { "@kozane/client": "0.1.0" } });
    expect(() => inspectCoreGraph(root, versions)).toThrow("directly depend");
  });
  it("rejects a missing installed peer", () => {
    const { root, core } = fixture();
    rmSync(core, { recursive: true });
    expect(() => inspectCoreGraph(root, versions)).toThrow("Missing installed");
  });
  it.each([undefined, "^0.1.0", "0.2.0"])("rejects missing or unsupported peer %s", (peer) => {
    const { root, client } = fixture();
    write(client, {
      name: "@kozane/client",
      version: "0.1.0",
      peerDependencies: peer ? { "@kozane/core": peer } : {},
    });
    expect(() => inspectCoreGraph(root, versions)).toThrow("exact core peer");
  });
  it.each(["core", "client"] as const)("rejects an unexpected %s version", (name) => {
    const paths = fixture();
    write(paths[name], { name: "@kozane/" + name, version: "0.2.0" });
    expect(() => inspectCoreGraph(paths.root, versions)).toThrow("Unexpected " + name + " version");
  });
  it.each(["0.1.0", "0.2.0"])("rejects a second physical core at version %s", (version) => {
    const { root, client } = fixture();
    write(join(client, "node_modules/@kozane/core"), { name: "@kozane/core", version });
    expect(() => inspectCoreGraph(root, versions)).toThrow("Duplicate core");
  });
  it("finds duplicate core through another runtime dependency", () => {
    const { root, client } = fixture();
    write(client, {
      name: "@kozane/client",
      version: "0.1.0",
      peerDependencies: { "@kozane/core": "0.1.0" },
      dependencies: { bridge: "1.0.0" },
    });
    const bridge = join(root, "node_modules/bridge");
    write(bridge, { name: "bridge", version: "1.0.0", dependencies: { "@kozane/core": "0.1.0" } });
    write(join(bridge, "node_modules/@kozane/core"), { name: "@kozane/core", version: "0.1.0" });
    expect(() => inspectCoreGraph(root, versions)).toThrow("Duplicate core");
  });
  it("rejects core declared as a client runtime dependency", () => {
    const { root, client } = fixture();
    write(client, {
      name: "@kozane/client",
      version: "0.1.0",
      peerDependencies: { "@kozane/core": "0.1.0" },
      dependencies: { "@kozane/core": "0.1.0" },
    });
    expect(() => inspectCoreGraph(root, versions)).toThrow("core peer, not a runtime dependency");
  });
});
