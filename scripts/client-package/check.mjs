import assert from "node:assert/strict";
import { copyFileSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import ts from "typescript";
const permitted = (name) =>
  ["@kozane/core", "@kozane/core/services", "@kozmof/reed", "svelte"].includes(name) ||
  name.startsWith("svelte/");
/** Inspect and compile only the installed tarball, without source aliases. */
export async function checkClientPackage({ consumer, run, manifest }) {
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
  for (const entry of Object.values(manifest.exports)) {
    assert.ok(existsSync(join(installed, entry.types)));
    assert.ok(existsSync(join(installed, entry.default)));
  }
  const source = join(consumer, "client-consumer.ts");
  copyFileSync(new URL("consumer.ts", import.meta.url), source);
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
  console.log(run(process.execPath, [join(out, "consumer.js")], consumer).trim());
  const entry = join(consumer, "client-browser.ts");
  writeFileSync(entry, 'export * from "@kozane/client";');
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
  console.log(
    "Packed client source/declaration closure and browser compilation passed without workspace aliases.",
  );
}
