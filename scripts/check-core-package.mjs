import { prepareCoreConsumer } from "./package-check/prepare.mjs";
import { checkCoreRuntime } from "./package-check/runtime.mjs";
import { checkCoreBrowser } from "./package-check/browser.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
const argumentsList = process.argv.slice(2);
const corpusScenarios =
  argumentsList
    .find((value) => value.startsWith("--corpus-scenarios="))
    ?.slice("--corpus-scenarios=".length) ?? "basic";
assert.ok(["basic", "boundaries"].includes(corpusScenarios), "Unsupported corpus scenarios");
const corpusDriver =
  argumentsList
    .find((value) => value.startsWith("--corpus-driver="))
    ?.slice("--corpus-driver=".length) ?? "wasm";
assert.ok(["wasm", "libsql"].includes(corpusDriver), "Unsupported corpus producer driver");
const repository = resolve(import.meta.dirname, "..");
const { checkCorpusRetention } = await import("./compatibility/retention.mjs");
checkCorpusRetention(repository);
// Native driver libraries must load from an executable filesystem. Tool sandboxes
// can force os.tmpdir() onto a restricted mount even when TMPDIR is supplied.
const temporaryRoot = join(repository, "tmp", "package-checks");
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(join(temporaryRoot, "kozane-core-package-"));
function run(command, args, cwd = repository, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      ...options,
      // Bound native pools so SvelteKit can create workers under thread quotas.
      env: {
        ...process.env,
        RAYON_NUM_THREADS: "1",
        TOKIO_WORKER_THREADS: "1",
        UV_THREADPOOL_SIZE: "1",
        ...options.env,
      },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${cause.stdout ?? ""}\n${cause.stderr ?? ""}`,
      { cause },
    );
  }
}
const artifactsOption = argumentsList.find((value) => value.startsWith("--artifacts="));
const artifacts = artifactsOption
  ? resolve(artifactsOption.slice("--artifacts=".length))
  : undefined;
try {
  run("pnpm", ["--filter", "@kozane/core", "check:migrations"]);
  run(process.execPath, ["packages/core/scripts/generate-schema.mjs", "--check"]);
  const context = await prepareCoreConsumer({
    repository,
    temporary,
    run,
    artifacts,
    clientPackage: argumentsList.includes("--client-package"),
  });
  const { archive, candidate, client } = context;
  await checkCoreRuntime({ repository, temporary, run, ...context });
  await checkCoreBrowser({ temporary, ...context });
  const corpusOption = argumentsList.find((value) => value.startsWith("--bootstrap-corpus="));
  if (corpusOption) {
    const { bootstrapCorpus } = await import("./compatibility/bootstrap.mjs");
    await bootstrapCorpus({
      consumer: temporary,
      archive: join(temporary, archive),
      candidate,
      driver: corpusDriver,
      scenarios: corpusScenarios,
      id: corpusOption.slice("--bootstrap-corpus=".length),
      run,
      repository,
    });
  }
  {
    const { checkCorpus } = await import("./compatibility/check.mjs");
    checkCorpus({
      consumer: temporary,
      repository,
      run,
      client: argumentsList.includes("--client-package"),
    });
  }
  if (argumentsList.includes("--client-package")) {
    const { checkClientPackage } = await import("./client-package/check.mjs");
    await checkClientPackage({
      consumer: temporary,
      run,
      manifest: client.manifest,
      browserOutput: argumentsList.includes("--client-browser-harness")
        ? resolve("tmp/client-package-harness")
        : undefined,
    });
  }
  if (argumentsList.includes("--client-package")) {
    console.log(
      run(
        process.execPath,
        [
          join(repository, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          join(repository, "vitest.package.config.ts"),
        ],
        repository,
        { env: { ...process.env, KOZANE_PACKAGE_CONSUMER: temporary } },
      ),
    );
  }
  if (argumentsList.includes("--restoration-harness")) {
    const { buildRestorationHarness } = await import("./restoration-harness/build.mjs");
    await buildRestorationHarness(temporary);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
