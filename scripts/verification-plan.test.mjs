import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePackageArtifacts } from "./prepare-package-artifacts.mjs";
import { verificationPlan } from "./verification-plan.mjs";
import { archiveName, validateReleaseArtifacts } from "./release-artifacts.mjs";

test("one build produces three archives and verification reuses them without lifecycle builds", () => {
  const repository = mkdtempSync(join(tmpdir(), "kozane-build-plan-"));
  try {
    const packages = ["core", "client", "kozane"].map((name) => ({
      name: name === "kozane" ? name : `@kozane/${name}`,
      version: "0.1.0",
    }));
    for (const [index, name] of ["core", "client", "kozane"].entries()) {
      mkdirSync(join(repository, "packages", name), { recursive: true });
      writeFileSync(
        join(repository, "packages", name, "package.json"),
        JSON.stringify(packages[index]),
      );
    }
    const directory = join(repository, "artifacts");
    const commands = [];
    const artifacts = preparePackageArtifacts({
      repository,
      directory,
      run(command, args) {
        commands.push([command, args]);
        if (args.includes("pack")) {
          const pkg = packages.find((item) => item.name === args[args.indexOf("--filter") + 1]);
          writeFileSync(join(directory, archiveName(pkg)), pkg.name);
          assert.ok(args.includes("--config.ignore-scripts=true"));
        }
      },
    });
    assert.deepEqual(commands[0], ["pnpm", ["build"]]);
    assert.equal(commands.filter(([, args]) => args.includes("build")).length, 1);
    assert.equal(commands.filter(([, args]) => args.includes("pack")).length, 3);
    validateReleaseArtifacts(
      { format: 1, commit: "commit", artifacts },
      packages,
      "commit",
      directory,
    );
    const plan = verificationPlan(directory);
    assert.ok(plan.some(([, args]) => args.includes("--artifacts=" + directory)));
    assert.ok(plan.some(([, args]) => args.includes("test:coverage:source")));
    for (const [, args] of plan)
      assert.ok(!args.some((arg) => ["build", "pack", "test:coverage"].includes(arg)));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
