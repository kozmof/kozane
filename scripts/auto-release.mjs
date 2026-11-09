import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export function releaseEnvironment(root, env = process.env) {
  if (env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG) return env;
  // Keep interactive login writable in managed workspaces and reuse it for publish.
  const fallback = join(root, "tmp", "npm-auth", "npmrc");
  mkdirSync(dirname(fallback), { recursive: true, mode: 0o700 });
  if (!existsSync(fallback)) writeFileSync(fallback, "", { mode: 0o600, flag: "wx" });
  return { ...env, npm_config_userconfig: fallback };
}

export function autoRelease({ root, args = [], run, output, exists = existsSync }) {
  assert.equal(args.length, 0, "Usage: pnpm release:auto");
  assert.equal(
    output("git", ["status", "--porcelain"]),
    "",
    "Commit source changes before releasing",
  );
  const commit = output("git", ["rev-parse", "HEAD"]);
  const directory = join(root, "tmp", "releases", commit);
  const script = join(root, "scripts", "local-release.mjs");
  if (!exists(join(directory, "release.json")))
    run(process.execPath, [script, "prepare", directory, "--skip-browser-tests"]);
  const registry = "--registry=https://registry.npmjs.org/";
  try {
    output("npm", ["whoami", registry]);
  } catch {
    run("npm", ["login", registry]);
    output("npm", ["whoami", registry]);
  }
  run(process.execPath, [script, "publish", directory]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const env = releaseEnvironment(root);
  autoRelease({
    root,
    args: process.argv.slice(2),
    run: (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit", env }),
    output: (command, args) =>
      execFileSync(command, args, { cwd: root, encoding: "utf8", env }).trim(),
  });
}
