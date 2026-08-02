import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  run("pnpm", [
    ...(process.env.KOZANE_ALLOW_UNSUPPORTED_NODE === "1" ? ["--config.ignore-scripts=true"] : []),
    "pack",
    "--pack-destination",
    staging,
  ]);
  const archive = readdirSync(staging).find((file) => file.endsWith(".tgz"));
  if (!archive) throw new Error("pnpm pack did not produce an archive");
  const archivePath = join(staging, archive);
  writeFileSync(join(staging, "package.json"), '{"private":true}\n');
  run(
    "npm",
    ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", archivePath],
    { cwd: staging },
  );
  run("npm", ["exec", "--", "kozane", "--version"], { cwd: staging });
  const installedRoot = join(staging, "node_modules", "kozane");
  run(process.execPath, [join(sourceRoot, "scripts", "smoke-production.mjs")], {
    env: { ...process.env, KOZANE_PACKAGE_ROOT: installedRoot },
  });
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
      archivePath,
    ],
    { cwd: staging },
  );
  const globalBin =
    process.platform === "win32"
      ? join(globalPrefix, "kozane.cmd")
      : join(globalPrefix, "bin", "kozane");
  run(globalBin, ["--version"], { cwd: staging });
  console.log("Local and global npm package smoke tests passed.");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
