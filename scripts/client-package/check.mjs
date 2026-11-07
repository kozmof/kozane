import assert from "node:assert/strict";
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import ts from "typescript";
const permitted = (name) =>
  ["@kozane/core", "@kozane/core/services", "@kozmof/reed", "svelte"].includes(name) ||
  name.startsWith("svelte/");
/** Inspect and compile only the installed tarball, without source aliases. */
export async function checkClientPackage({ consumer, run, manifest, browserOutput }) {
  const { checkCoreRuntime } = await import("./check-core-runtime.mjs");
  checkCoreRuntime({ consumer, run, manifest });
  const installed = join(consumer, "node_modules/@kozane/client");
  function inspect(file) {
    const text = readFileSync(file, "utf8");
    const parts = file.endsWith(".svelte")
      ? [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
      : [text];
    for (const part of parts) {
      const tree = ts.createSourceFile(file, part, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      function visit(node) {
        let value;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          value = node.moduleSpecifier.text;
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          value = node.argument.literal.text;
        if (value) {
          if (value.startsWith(".")) {
            const target = resolve(dirname(file), value);
            assert.ok(
              target.startsWith(installed + "/"),
              `Client import escapes package: ${value}`,
            );
            assert.ok(
              [target, target.replace(/\.js$/, ".d.ts"), target + ".d.ts"].some(existsSync),
              `Missing client dependency: ${value} from ${file}`,
            );
            if (file.endsWith(".d.ts")) {
              const declaration = /\.[cm]?js$/.test(target)
                ? target.replace(/\.[cm]?js$/, ".d.ts")
                : target.endsWith(".svelte")
                  ? target + ".d.ts"
                  : target;
              assert.ok(
                [declaration, declaration + ".d.ts", join(declaration, "index.d.ts")].some(
                  existsSync,
                ),
                `Missing client declaration: ${value} from ${file}`,
              );
            }
          } else assert.ok(permitted(value), `Unexpected client dependency ${value} from ${file}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:js|ts|svelte)$/.test(file)) inspect(file);
    }
  }
  walk(join(installed, "dist"));
  const mapDeclaration = join(installed, "dist/backend/views/map.d.ts");
  const originalDeclaration = readFileSync(mapDeclaration);
  try {
    rmSync(mapDeclaration);
    assert.throws(
      () => inspect(join(installed, "dist/map/types.d.ts")),
      /Missing client declaration/,
    );
  } finally {
    writeFileSync(mapDeclaration, originalDeclaration);
  }
  for (const entry of Object.values(manifest.exports)) {
    if (typeof entry === "string") {
      assert.ok(existsSync(join(installed, entry)));
      continue;
    }
    assert.ok(existsSync(join(installed, entry.types)));
    assert.ok(existsSync(join(installed, entry.default)));
  }
  for (const name of ["testing-consumer.mjs", "testing-http-fixture.mjs"])
    copyFileSync(new URL(name, import.meta.url), join(consumer, name));
  console.log(run(process.execPath, [join(consumer, "testing-consumer.mjs")], consumer).trim());
  copyFileSync(new URL("view-fixture.ts", import.meta.url), join(consumer, "view-fixture.ts"));
  const source = join(consumer, "client-consumer.ts");
  copyFileSync(new URL("consumer.ts", import.meta.url), source);
  const inputs = join(consumer, "client-resource-inputs.ts");
  const resourceFixture = readFileSync(
    new URL("../../packages/kozane/src/test-utils/backend-inputs.typecheck.ts", import.meta.url),
    "utf8",
  );
  const backendSource = "../../../client/src/backend/index.js";
  assert.equal(resourceFixture.split(backendSource).length - 1, 2);
  writeFileSync(inputs, resourceFixture.replaceAll(backendSource, "@kozane/client"));
  run(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--strict",
      "--skipLibCheck",
      "--lib",
      "ES2024,DOM,DOM.Iterable",
      source,
      inputs,
    ],
    consumer,
  );
  const out = join(consumer, "client-server");
  await build({
    configFile: false,
    root: consumer,
    publicDir: false,
    plugins: [svelte({ configFile: false })],
    ssr: {
      noExternal: ["@kozane/client", "@kozmof/reed"],
      external: ["svelte", "@kozane/core"],
    },
    build: {
      outDir: out,
      ssr: source,
      rollupOptions: { output: { entryFileNames: "consumer.js" } },
    },
  });
  const renderer = join(consumer, "render-client.mjs");
  writeFileSync(
    renderer,
    'import { styleFixtureHtml, viewFixtureHtml } from "./client-server/consumer.js";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./client-fixture.html", import.meta.url), styleFixtureHtml);\nwriteFileSync(new URL("./view-fixtures.json", import.meta.url), JSON.stringify(viewFixtureHtml));',
  );
  console.log(run(process.execPath, [renderer], consumer).trim());
  const entry = join(consumer, "client-browser.ts");
  writeFileSync(entry, 'export * from "@kozane/client"; export * from "@kozane/client/ui";');
  await build({
    configFile: false,
    root: consumer,
    publicDir: false,
    plugins: [svelte({ configFile: false })],
    build: {
      outDir: join(consumer, "client-browser"),
      lib: { entry, formats: ["es"], fileName: () => "client.js" },
    },
  });
  const stylesheet = readFileSync(join(installed, "dist/styles.css"), "utf8");
  assert.ok(
    /^@layer reset, base, tokens, recipes, utilities;/.test(stylesheet),
    "Packed CSS layer order is missing",
  );
  assert.equal(
    (stylesheet.match(/@layer reset, base, tokens, recipes, utilities;/g) ?? []).length,
    1,
  );
  assert.ok(
    /--colors-ink-black:\s*#1c1c1c/.test(stylesheet),
    "Packed CSS is missing its ink token",
  );
  assert.ok(/box-sizing:\s*border-box/.test(stylesheet), "Packed CSS is missing its reset");
  assert.ok(/@layer utilities/.test(stylesheet), "Packed CSS is missing utilities");
  assert.ok(
    !existsSync(join(consumer, "node_modules/@pandacss/dev")),
    "Consumer must not require Panda",
  );
  const app = join(consumer, "client-app-source");
  mkdirSync(app);
  copyFileSync(new URL("styles-browser.ts", import.meta.url), join(app, "main.ts"));
  copyFileSync(
    new URL("verify-core-identity.mjs", import.meta.url),
    join(app, "verify-core-identity.mjs"),
  );
  writeFileSync(
    join(app, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Packed client styles</title><link rel="icon" href="data:,"><body>' +
      readFileSync(join(consumer, "client-fixture.html"), "utf8") +
      '<script type="module" src="./main.ts"></script></body>',
  );
  copyFileSync(new URL("views-browser.ts", import.meta.url), join(app, "views.ts"));
  copyFileSync(new URL("view-fixture.ts", import.meta.url), join(app, "view-fixture.ts"));
  const views = JSON.parse(readFileSync(join(consumer, "view-fixtures.json"), "utf8"));
  for (const name of ["board", "tags", "map"]) {
    writeFileSync(
      join(app, name + ".html"),
      '<!doctype html><meta charset="utf-8"><title>Packed ' +
        name +
        '</title><link rel="icon" href="data:,"><body data-view="' +
        name +
        '"><main id="packed-view">' +
        views[name] +
        '</main><script type="module" src="./views.ts"></script></body>',
    );
  }
  const production = join(consumer, "client-app");
  await build({
    configFile: false,
    root: app,
    publicDir: false,
    plugins: [svelte({ configFile: false })],
    css: { postcss: { plugins: [] } },
    build: {
      outDir: production,
      emptyOutDir: true,
      rollupOptions: {
        input: Object.fromEntries(
          ["index", "board", "tags", "map"].map((name) => [name, join(app, name + ".html")]),
        ),
      },
    },
  });
  const css = readdirSync(join(production, "assets")).filter((name) => name.endsWith(".css"));
  assert.ok(css.length, "Production bundler removed the stylesheet");
  const retained = css
    .map((name) => readFileSync(join(production, "assets", name), "utf8"))
    .join("\n");
  assert.ok(/--colors-ink-black/.test(retained), "Production CSS lost its ink token");
  const layers = [
    ...new Set(
      [...retained.matchAll(/@layer\s+([\w\s,.-]+)[;{]/g)].flatMap((match) =>
        match[1].split(",").map((name) => name.trim().split(".")[0]),
      ),
    ),
  ];
  assert.deepEqual(
    layers.slice(0, 5),
    ["reset", "base", "tokens", "recipes", "utilities"],
    "Production CSS layer precedence changed",
  );
  assert.match(readFileSync(join(production, "index.html"), "utf8"), /rel="stylesheet"/);
  if (browserOutput) {
    rmSync(browserOutput, { recursive: true, force: true });
    cpSync(production, browserOutput, { recursive: true });
  }
  const { checkSvelteKit } = await import("./check-sveltekit.mjs");
  checkSvelteKit({ consumer, run, browserOutput });
  console.log(
    "Packed client source/declaration closure, SSR, browser compilation and production stylesheet retention passed without workspace aliases or consumer codegen.",
  );
}
