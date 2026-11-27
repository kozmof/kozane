/** Run the fixed capture gate without inherited adapter selection or test filters. */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const captureSuites = Object.freeze([
  "packages/kozane/src/db/api/action-capture.test.ts",
  "packages/kozane/src/db/api/action-capture-integration.test.ts",
  "packages/kozane/src/db/api/action-restoration.test.ts",
  "packages/kozane/src/db/api/action-restoration-validation.test.ts",
  "packages/kozane/src/db/api/action-asset-history.test.ts",
  "packages/kozane/src/db/api/action-epochs.test.ts",
  "packages/kozane/src/db/api/action-initialization.test.ts",
  "packages/kozane/src/db/api/recovery-checkpoint-capture.test.ts",
]);
export function actionCapturePlan(adapter, environment = process.env) {
  if (!["native", "wasm", "browser"].includes(adapter))
    throw new Error("Usage: check-action-capture.mjs <native | wasm | browser>");
  const parity = adapter !== "native";
  return {
    args: [
      resolve(repository, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      parity ? "scripts/database-parity/vitest.config.ts" : "vitest.source.config.ts",
      "--maxWorkers=1",
      "--allowOnly=false",
      ...captureSuites,
      ...(parity ? ["scripts/database-parity/concurrency.test.ts"] : []),
    ],
    cwd: repository,
    env: { ...environment, KOZANE_DB_BROWSER: adapter === "browser" ? "1" : "0" },
  };
}
/** A successful process must also prove that every required file ran without skipped checks. */
export function verifyCaptureResults(report, adapter) {
  const expected = actionCapturePlan(adapter, {})
    .args.filter((arg) => arg.endsWith(".test.ts"))
    .map((file) => resolve(repository, file));
  if (
    !report.success ||
    report.numFailedTests !== 0 ||
    report.numPassedTests < 1 ||
    report.numPendingTests > 0 ||
    report.numTodoTests > 0 ||
    !Array.isArray(report.testResults)
  )
    throw new Error("Capture gate did not complete every required check");
  const actual = report.testResults.map((suite) => resolve(suite.name));
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== expected.length ||
    expected.some((file) => !actual.includes(file))
  )
    throw new Error("Capture gate suite inventory is incomplete or changed");
  for (const suite of report.testResults)
    if (
      suite.status !== "passed" ||
      !Array.isArray(suite.assertionResults) ||
      suite.assertionResults.length === 0 ||
      suite.assertionResults.some((test) => test.status !== "passed")
    )
      throw new Error("Capture gate contains failed, skipped or empty suites");
}
export function checkActionCapture(args, { run = execFileSync, env = process.env } = {}) {
  if (args.length !== 1)
    throw new Error("Usage: check-action-capture.mjs <native | wasm | browser>");
  const { args: parameters, ...options } = actionCapturePlan(args[0], env);
  const temporary = mkdtempSync(join(tmpdir(), "kozane-capture-gate-"));
  try {
    const report = join(temporary, "results.json");
    run(
      process.execPath,
      [...parameters, "--reporter=default", "--reporter=json", "--outputFile=" + report],
      { ...options, stdio: "inherit" },
    );
    verifyCaptureResults(JSON.parse(readFileSync(report, "utf8")), args[0]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkActionCapture(process.argv.slice(2));
  } catch (error) {
    if (Number.isInteger(error.status) && error.status > 0) process.exitCode = error.status;
    else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
