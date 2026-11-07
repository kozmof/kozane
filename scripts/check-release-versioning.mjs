import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const staging = mkdtempSync(join(tmpdir(), "kozane-release-versioning-"));
const read = (path) => JSON.parse(readFileSync(join(staging, path), "utf8"));
try {
  for (const file of [
    "package.json",
    "pnpm-workspace.yaml",
    ".changeset/config.json",
    ...["core", "client", "kozane"].map((name) => `packages/${name}/package.json`),
  ]) {
    mkdirSync(resolve(staging, file, ".."), { recursive: true });
    copyFileSync(join(root, file), join(staging, file));
  }
  symlinkSync(join(root, "node_modules"), join(staging, "node_modules"), "dir");
  const version = () => {
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/@changesets/cli/bin.js"), "version"],
      { cwd: staging, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  writeFileSync(
    join(staging, ".changeset/cli-upgrade.md"),
    '---\n"kozane": minor\n---\n\nCheck the CLI release.\n',
  );
  const initial = read("packages/kozane/package.json").version;
  version();
  const first = read("packages/kozane/package.json").version;
  assert.notEqual(first, initial);
  writeFileSync(
    join(staging, ".changeset/core-client-upgrade.md"),
    '---\n"@kozane/core": minor\n"@kozane/client": minor\n---\n\nCheck a future coordinated API upgrade.\n',
  );
  version();
  const core = read("packages/core/package.json");
  const client = read("packages/client/package.json");
  const cli = read("packages/kozane/package.json");
  assert.equal(client.peerDependencies[core.name], core.version);
  assert.equal(client.devDependencies[core.name], `workspace:${core.version}`);
  assert.equal(cli.dependencies[core.name], `workspace:${core.version}`);
  assert.equal(cli.dependencies[client.name], `workspace:${client.version}`);
  assert.equal(read("package.json").dependencies[core.name], `workspace:${core.version}`);
  assert.equal(read("package.json").dependencies[client.name], `workspace:${client.version}`);
  console.log(
    "Changesets versions the CLI and preserves exact core/client pins through a coordinated API upgrade in an isolated workspace.",
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
