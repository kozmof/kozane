import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkCoreRuntime } from "../../scripts/client-package/check-core-runtime.mjs";

const consumer = process.env.KOZANE_PACKAGE_CONSUMER;
if (!consumer)
  throw new Error("Installed package tests require an isolated consumer. Run pnpm test:packages.");
const directory = realpathSync(consumer);
const manifest = JSON.parse(
  readFileSync(join(directory, "node_modules/@kozane/client/package.json"), "utf8"),
);
test("installed public packages share one expected core instance and error identity", () => {
  checkCoreRuntime({
    consumer: directory,
    manifest,
    run: (command: string, args: string[], cwd: string) =>
      execFileSync(command, args, { cwd, encoding: "utf8" }),
  });
});
test("host integration imports work in Node and private package paths stay closed", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    import * as host from '@kozane/client/host';
    import { readFileSync, realpathSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    assert.equal(typeof host.browserPollLifecycle, 'function');
    assert.equal(host.readString({ value: 'public' }, 'value'), 'public');
    assert.deepEqual(host.parseWarpEntries([]), []);
    const entry = realpathSync(fileURLToPath(import.meta.resolve('@kozane/client')));
    assert.ok(entry.startsWith(process.cwd() + '/'), 'Package must resolve inside the isolated consumer');
    assert.match(readFileSync(fileURLToPath(import.meta.resolve('@kozane/client/base.css')), 'utf8'), /@layer reset/);
    await assert.rejects(import('@kozane/client/dist/backend/contract.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    console.log('Installed host and exports passed');
  `,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  expect(result).toContain("Installed host and exports passed");
});
