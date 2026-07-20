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

const pnpmArgs = (...args) =>
  process.env.KOZANE_ALLOW_UNSUPPORTED_NODE === "1"
    ? ["--config.engine-strict=false", ...args]
    : args;

try {
  run(
    "pnpm",
    pnpmArgs(
      ...(process.env.KOZANE_ALLOW_UNSUPPORTED_NODE === "1"
        ? ["--config.ignore-scripts=true"]
        : []),
      "pack",
      "--pack-destination",
      staging,
    ),
  );
  const archive = readdirSync(staging).find((file) => file.endsWith(".tgz"));
  if (!archive) throw new Error("pnpm pack did not produce an archive");
  writeFileSync(join(staging, "package.json"), '{"private":true}\n');
  run("pnpm", pnpmArgs("add", "--ignore-scripts", join(staging, archive)), {
    cwd: staging,
  });
  const installedRoot = join(staging, "node_modules", "kozane");
  run(process.execPath, [join(sourceRoot, "scripts", "smoke-production.mjs")], {
    env: { ...process.env, KOZANE_PACKAGE_ROOT: installedRoot },
  });
  console.log("Installed package smoke test passed.");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
