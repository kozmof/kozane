import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const options = process.argv.slice(2);
if (options.some((option) => option !== "--install-only")) {
  throw new Error("Usage: node scripts/smoke-package.mjs [--install-only]");
}
const installOnly = options.includes("--install-only");

const sourceRoot = resolve(import.meta.dirname, "..");
const staging = mkdtempSync(join(tmpdir(), "kozane-package-smoke-"));

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
}

try {
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
  writeFileSync(join(staging, "package.json"), '{"private":true}\n');
  run(
    "npm",
    [
      "install",
      "--save-dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      coreArchivePath,
      clientArchivePath,
      archivePath,
    ],
    { cwd: staging },
  );
  run("npm", ["exec", "--", "kozane", "--version"], { cwd: staging });
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
      coreArchivePath,
      clientArchivePath,
      archivePath,
    ],
    { cwd: staging },
  );
  const globalBin =
    process.platform === "win32"
      ? join(globalPrefix, "kozane.cmd")
      : join(globalPrefix, "bin", "kozane");
  run(globalBin, ["--version"], { cwd: staging });
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
