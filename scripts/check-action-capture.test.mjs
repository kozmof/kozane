import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  actionCapturePlan,
  captureSuites,
  checkActionCapture,
  verifyCaptureResults,
} from "./check-action-capture.mjs";

test("all adapters retain the complete capture, restoration, asset and epoch gate", () => {
  assert.ok(Object.isFrozen(captureSuites));
  assert.equal(new Set(captureSuites).size, 8);
  for (const suite of captureSuites) assert.ok(existsSync(suite), `Missing capture suite ${suite}`);
  for (const adapter of ["native", "wasm", "browser"]) {
    const { args } = actionCapturePlan(adapter, {});
    assert.equal(args[1], "run");
    assert.equal(
      args[args.indexOf("--config") + 1],
      adapter === "native" ? "vitest.source.config.ts" : "scripts/database-parity/vitest.config.ts",
    );
    assert.ok(args.includes("--maxWorkers=1"));
    assert.ok(args.includes("--allowOnly=false"));
    for (const suite of captureSuites) assert.ok(args.includes(suite));
    assert.equal(
      args.includes("scripts/database-parity/concurrency.test.ts"),
      adapter !== "native",
    );
    assert.ok(
      !args.some((arg) => arg.includes("/lib/server/")),
      "Browser gate must not load Node host fixtures",
    );
    assert.ok(!args.includes("--passWithNoTests"));
  }
});
test("a zero exit cannot substitute for missing, skipped, duplicate or failed browser suites", () => {
  const files = actionCapturePlan("browser", {}).args.filter((arg) => arg.endsWith(".test.ts"));
  const complete = {
    success: true,
    numFailedTests: 0,
    numPassedTests: files.length,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: files.map((file) => ({
      name: resolve(file),
      status: "passed",
      assertionResults: [{ status: "passed" }],
    })),
  };
  verifyCaptureResults(complete, "browser");
  for (const change of [
    (report) => {
      report.success = false;
    },
    (report) => {
      report.testResults.pop();
    },
    (report) => {
      report.testResults[0] = report.testResults[1];
    },
    (report) => {
      report.numPendingTests = 1;
    },
    (report) => {
      report.testResults[0].assertionResults[0].status = "pending";
    },
    (report) => {
      report.testResults[0].assertionResults = [];
    },
    (report) => {
      report.testResults[0].status = "failed";
    },
  ]) {
    const report = structuredClone(complete);
    change(report);
    assert.throws(() => verifyCaptureResults(report, "browser"), /Capture gate/);
  }
});
test("explicit adapter choice overrides ambient browser flags without mutating the host environment", () => {
  const env = {
    KOZANE_DB_BROWSER: "1",
    NODE_OPTIONS: "--v8-pool-size=1",
    TEST_SENTINEL: "retained",
  };
  assert.equal(actionCapturePlan("native", env).env.KOZANE_DB_BROWSER, "0");
  assert.equal(actionCapturePlan("wasm", env).env.KOZANE_DB_BROWSER, "0");
  const browser = actionCapturePlan("browser", { ...env, KOZANE_DB_BROWSER: "0" });
  assert.equal(browser.env.KOZANE_DB_BROWSER, "1");
  assert.equal(browser.env.NODE_OPTIONS, env.NODE_OPTIONS);
  assert.equal(browser.env.TEST_SENTINEL, env.TEST_SENTINEL);
  assert.equal(env.KOZANE_DB_BROWSER, "1");
});
test("capture commands use the installed Vitest entry and propagate test process failures", () => {
  const failure = new Error("Vitest failed");
  failure.status = 7;
  assert.throws(
    () =>
      checkActionCapture(["browser"], {
        env: {},
        run(command, args, options) {
          assert.equal(command, process.execPath);
          assert.equal(args[0], resolve("node_modules/vitest/vitest.mjs"));
          assert.equal(options.cwd, resolve("."));
          assert.equal(options.stdio, "inherit");
          assert.equal(options.env.KOZANE_DB_BROWSER, "1");
          throw failure;
        },
      }),
    (error) => error === failure,
  );
});
test("gate commands refuse filters, alternate configs and unsupported adapters before running tests", () => {
  for (const args of [
    [],
    ["unknown"],
    ["browser", "--testNamePattern=absent"],
    ["wasm", "--passWithNoTests"],
    ["native", "--config=other.ts"],
  ]) {
    let invoked = false;
    assert.throws(
      () =>
        checkActionCapture(args, {
          run() {
            invoked = true;
          },
        }),
      /Usage/,
    );
    assert.equal(invoked, false);
  }
  const result = spawnSync(process.execPath, ["scripts/check-action-capture.mjs", "invalid"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage/);
});
test("CI runs browser capture after Chromium installation and before package preparation", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const browser = workflow.slice(workflow.indexOf("  browser-e2e:"));
  const install = browser.indexOf("playwright install --with-deps chromium"),
    capture = browser.indexOf("pnpm test:capture:browser"),
    build = browser.indexOf("pnpm build:packages");
  assert.ok(install >= 0 && capture > install && build > capture);
  assert.ok(!browser.slice(install, build).includes("continue-on-error"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const adapter of ["native", "wasm", "browser"])
    assert.equal(
      pkg.scripts[`test:capture:${adapter}`],
      `node scripts/check-action-capture.mjs ${adapter}`,
    );
});
