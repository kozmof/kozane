import { prepareBrowserCorpus } from "../compatibility/prepare-browser.mjs";
import { build } from "vite";
import ts from "typescript";
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
/** Build only from the installed consumer's public core, Drizzle and wasm dependencies. */
export async function buildRestorationHarness(
  consumer,
  output = resolve("tmp/restoration-harness"),
) {
  const sources = join(consumer, "restoration");
  await mkdir(sources, { recursive: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  prepareBrowserCorpus(resolve("tests/compatibility/corpus"), output);
  for (const name of [
    "main.ts",
    "verified-loader.ts",
    "deadline.ts",
    "corpus-compatibility.ts",
    "worker.ts",
    "worker-context.ts",
    "session.ts",
    "recovery.ts",
    "navigation.ts",
    "attempt.ts",
    "active-clock.ts",
    "resume-gate.ts",
    "suspension.ts",
    "reset.ts",
    "validation.ts",
    "generate-fixture.mjs",
    "node-check.mjs",
    "worker-check.mjs",
  ]) {
    await copyFile(new URL(name, import.meta.url), join(sources, name));
  }
  await copyFile(
    new URL("../../packages/client/src/client/operation-queue.ts", import.meta.url),
    join(sources, "operation-queue.ts"),
  );
  execFileSync(process.execPath, [join(sources, "generate-fixture.mjs"), output], {
    cwd: consumer,
    stdio: "inherit",
  });
  await writeFile(
    join(sources, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2024", "DOM", "DOM.Iterable", "WebWorker"],
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: ["*.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [resolve("node_modules/typescript/bin/tsc"), "--project", join(sources, "tsconfig.json")],
    { cwd: consumer, stdio: "inherit" },
  );
  const buildId = randomUUID();
  async function bundle(name, define) {
    await build({
      configFile: false,
      root: consumer,
      publicDir: false,
      define,
      build: {
        outDir: output,
        emptyOutDir: false,
        lib: { entry: join(sources, `${name}.ts`), formats: ["es"], fileName: () => `${name}.js` },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
  }
  await bundle("worker", { __SPIKE_BUILD_ID__: JSON.stringify(buildId) });
  const workerSource = await readFile(join(output, "worker.js"), "utf8");
  const syntax = ts.createSourceFile(
    "worker.js",
    workerSource,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  function inspect(node) {
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    )
      throw new Error("Verified worker must have no runtime imports");
    ts.forEachChild(node, inspect);
  }
  inspect(syntax);
  const require = createRequire(join(consumer, "package.json"));
  await copyFile(
    require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"),
    join(output, "sqlite3.wasm"),
  );
  const hash = async (name) =>
    createHash("sha256")
      .update(await readFile(join(output, name)))
      .digest("hex");
  const fixture = JSON.parse(await readFile(join(output, "fixture.json"), "utf8"));
  const manifest = {
    ...fixture,
    buildId,
    workerHash: await hash("worker.js"),
    wasmHash: await hash("sqlite3.wasm"),
  };
  execFileSync(
    process.execPath,
    [
      "--import",
      resolve("node_modules/tsx/dist/loader.mjs"),
      join(sources, "node-check.mjs"),
      join(output, "sample.db"),
      fixture.sampleNamespaceId,
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      join(sources, "worker-check.mjs"),
      join(output, "worker.js"),
      join(output, "sqlite3.wasm"),
      join(output, "sample.db"),
      buildId,
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  await bundle("main", { __RESTORATION_MANIFEST__: JSON.stringify(manifest) });
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'"><title>Packed restoration harness</title><body>Preparing restoration harness<script type="module" src="./main.js"></script>`,
  );
  await writeFile(
    join(output, "away.html"),
    "<!doctype html><meta charset=utf-8><title>BFCache navigation target</title><p>Return to the restoration harness.</p>",
  );
  console.log(`Built packed restoration harness at ${output}. Browser tests have not run.`);
}
