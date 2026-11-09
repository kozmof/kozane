import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const options = process.argv.slice(2);
const artifactsOption = options.find((option) => option.startsWith("--artifacts="));
if (
  options.some(
    (option) =>
      !["--install-only", "--registry"].includes(option) && !option.startsWith("--artifacts="),
  )
) {
  throw new Error(
    "Usage: node scripts/smoke-package.mjs [--install-only] [--registry | --artifacts=<directory>]",
  );
}
const registry = options.includes("--registry");
if (registry && artifactsOption)
  throw new Error("Registry and prepared archives are separate smoke sources");
const registryOptions = registry
  ? ["--registry=https://registry.npmjs.org/", "--safe-chain-skip-minimum-package-age=true", `--before=${new Date().toISOString()}`]
  : [];
const installOnly = options.includes("--install-only");

const sourceRoot = resolve(import.meta.dirname, "..");
// Execute installed bin links and native libraries on the workspace filesystem.
// System temporary directories may be mounted with noexec.
const temporaryRoot = join(sourceRoot, "tmp", "package-checks");
mkdirSync(temporaryRoot, { recursive: true });
const staging = mkdtempSync(join(temporaryRoot, "kozane-package-smoke-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: "pipe",
    env:
      process.env.KOZANE_ALLOW_UNSUPPORTED_NODE === "1"
        ? { ...process.env, npm_config_engine_strict: "false" }
        : process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function installationTargets() {
  if (artifactsOption) {
    const directory = resolve(artifactsOption.slice("--artifacts=".length));
    return ["core", "client", "kozane"].map((name) => {
      const pkg = JSON.parse(
        readFileSync(join(sourceRoot, "packages", name, "package.json"), "utf8"),
      );
      return join(directory, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
    });
  }
  if (registry) {
    return ["core", "client", "kozane"].map((directory) => {
      const { name, version } = JSON.parse(
        readFileSync(join(sourceRoot, "packages", directory, "package.json"), "utf8"),
      );
      return name + "@" + version;
    });
  }
  run("pnpm", ["--filter", "@kozane/core", "pack", "--pack-destination", staging]);
  const coreArchive = readdirSync(staging).find(
    (file) => file.startsWith("kozane-core-") && file.endsWith(".tgz"),
  );
  if (!coreArchive) throw new Error("Missing packed core dependency");
  const coreArchivePath = join(staging, coreArchive);
  run("pnpm", ["--filter", "@kozane/client", "pack", "--pack-destination", staging]);
  const clientArchive = readdirSync(staging).find(
    (file) => file.startsWith("kozane-client-") && file.endsWith(".tgz"),
  );
  if (!clientArchive) throw new Error("Missing packed client dependency");
  const clientArchivePath = join(staging, clientArchive);
  run("pnpm", [
    ...(process.env.KOZANE_ALLOW_UNSUPPORTED_NODE === "1" ? ["--config.ignore-scripts=true"] : []),
    "--filter",
    "kozane",
    "pack",
    "--pack-destination",
    staging,
  ]);
  const { name, version } = JSON.parse(
    readFileSync(join(sourceRoot, "packages/kozane/package.json"), "utf8"),
  );
  const archive = readdirSync(staging).find((file) => file === name + "-" + version + ".tgz");
  if (!archive) throw new Error("pnpm pack did not produce an archive");
  const archivePath = join(staging, archive);
  return [coreArchivePath, clientArchivePath, archivePath];
}

try {
  const targets = installationTargets();
  const expectedVersion = JSON.parse(
    readFileSync(join(sourceRoot, "packages/kozane/package.json"), "utf8"),
  ).version;
  writeFileSync(join(staging, "package.json"), '{"private":true}\n');
  run(
    "npm",
    [
      "install",
      "--save-dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...registryOptions,
      ...targets,
    ],
    {
      cwd: staging,
    },
  );
  assert.equal(
    run("npm", ["exec", "--", "kozane", "--version"], { cwd: staging }).trim(),
    expectedVersion,
  );
  const installedRoot = join(staging, "node_modules", "kozane");
  run(process.execPath, [join(sourceRoot, "scripts/check-node-core.mjs"), installedRoot]);
  if (!installOnly) {
    run(process.execPath, [join(sourceRoot, "scripts", "smoke-production.mjs")], {
      env: { ...process.env, KOZANE_PACKAGE_ROOT: installedRoot },
    });
  }
  const globalPrefix = join(staging, "global");
  run(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      globalPrefix,
      ...registryOptions,
      ...targets,
    ],
    { cwd: staging },
  );
  const globalBin =
    process.platform === "win32"
      ? join(globalPrefix, "kozane.cmd")
      : join(globalPrefix, "bin", "kozane");
  assert.equal(run(globalBin, ["--version"], { cwd: staging }).trim(), expectedVersion);
  const globalRoot = join(
    globalPrefix,
    ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]),
    "kozane",
  );
  run(process.execPath, [join(sourceRoot, "scripts/check-node-core.mjs"), globalRoot]);
  console.log(
    installOnly
      ? "Local and global npm installation, executable and public runtime identity checks passed. HTTP checks were not run."
      : "Local and global npm package smoke tests passed.",
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
