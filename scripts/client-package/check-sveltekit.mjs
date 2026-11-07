import { checkCoreRuntime } from "./check-core-runtime.mjs";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";

/** Build a separate Kit consumer using the candidate tarballs and locked registry artifacts. */
export function checkSvelteKit({ consumer, run, browserOutput }) {
  const root = mkdtempSync(join(dirname(consumer), "kozane-client-kit-"));
  try {
    const repository = resolve(import.meta.dirname, "../..");
    const lock = readFileSync(join(repository, "pnpm-lock.yaml"), "utf8");
    const candidateLock = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
    const source = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"));
    const dependencies = Object.fromEntries(
      ["@kozane/core", "@kozane/client", "svelte"].map((name) => [name, source.dependencies[name]]),
    );
    const development = [
      "@sveltejs/kit",
      "@sveltejs/adapter-static",
      "@sveltejs/vite-plugin-svelte",
      "vite",
      "typescript",
      "svelte-check",
    ];
    const references = {};
    const importers = lock.split("\npackages:\n")[0];
    for (const name of [...development, "svelte"]) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = importers.match(
        new RegExp(`^ {6}'?${escaped}'?:\\n {8}specifier: [^\\n]+\\n {8}version: ([^\\n]+)`, "m"),
      );
      assert.ok(match, `Missing locked consumer tool ${name}`);
      references[name] = match[1].replace(/^'|'$/g, "");
    }
    const devDependencies = Object.fromEntries(
      development.map((name) => [name, references[name].split("(")[0]]),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies, devDependencies }),
    );
    function merge(section) {
      const blocks = new Map();
      for (const text of [lock, candidateLock]) {
        const content =
          section === "packages"
            ? text.split("\npackages:\n")[1].split("\nsnapshots:\n")[0]
            : text.split("\nsnapshots:\n")[1];
        for (const block of content.split(/\n(?= {2}\S)/).filter((value) => value.trim())) {
          const key = block.match(/^\s{2}(.+?):(?:\n| \{\})/);
          assert.ok(key, "Invalid locked artifact");
          const name = key[1].replace(/^['"]|['"]$/g, "");
          if (!blocks.has(name)) blocks.set(name, block.replace(/^\n/, "").trimEnd());
        }
      }
      return [...blocks.values()].join("\n");
    }
    const importer = (values) =>
      Object.entries(values)
        .map(
          ([name, specifier]) =>
            `      ${JSON.stringify(name)}:\n        specifier: ${JSON.stringify(specifier)}\n        version: ${JSON.stringify(references[name] ?? specifier)}`,
        )
        .join("\n");
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n${importer(dependencies)}\n    devDependencies:\n${importer(devDependencies)}\npackages:\n${merge("packages")}\nsnapshots:\n${merge("snapshots")}\n`,
    );
    writeFileSync(join(root, ".npmrc"), "manage-package-manager-versions=false\n");
    run(
      "pnpm",
      [
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prod=false",
        "--ignore-workspace",
        "--store-dir",
        dirname(run("pnpm", ["store", "path"], repository).trim()),
      ],
      root,
    );
    assert.equal(existsSync(join(root, "node_modules/@pandacss/dev")), false);
    const manifest = JSON.parse(
      readFileSync(join(consumer, "node_modules/@kozane/client/package.json"), "utf8"),
    );
    checkCoreRuntime({ consumer: root, run, manifest });
    cpSync(new URL("sveltekit/svelte.config.js", import.meta.url), join(root, "svelte.config.js"));
    cpSync(new URL("sveltekit/vite.config.js", import.meta.url), join(root, "vite.config.js"));
    mkdirSync(join(root, "src"));
    cpSync(new URL("sveltekit/app.html", import.meta.url), join(root, "src/app.html"));
    cpSync(new URL("sveltekit/routes", import.meta.url), join(root, "src/routes"), {
      recursive: true,
    });
    cpSync(new URL("view-fixture.ts", import.meta.url), join(root, "src/view-fixture.ts"));
    cpSync(
      new URL("verify-core-identity.mjs", import.meta.url),
      join(root, "src/verify-core-identity.mjs"),
    );
    run(process.execPath, [join(root, "node_modules/@sveltejs/kit/svelte-kit.js"), "sync"], root);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: "./.svelte-kit/tsconfig.json",
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          strict: true,
          skipLibCheck: true,
          moduleResolution: "bundler",
        },
      }),
    );
    const diagnostics = run(
      process.execPath,
      [join(root, "node_modules/svelte-check/bin/svelte-check"), "--tsconfig", "./tsconfig.json"],
      root,
    );
    assert.match(diagnostics, /0 errors and 0 warnings/);
    run(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build"], root);
    for (const view of ["board", "tags", "map", "editor"]) {
      const html = readFileSync(join(root, "build", view, "index.html"), "utf8");
      assert.match(html, new RegExp(`data-kit-view="${view}"`));
      assert.match(html, /data-kit-ready="false"/);
      assert.ok(
        html.includes(
          view === "map"
            ? "General"
            : view === "editor"
              ? "Kit editor 日本語"
              : "Packed board 日本語",
        ),
      );
      const assets = [...html.matchAll(/href="([^"]*_app\/immutable\/[^"]+)"/g)].map(
        (match) => new URL(match[1], `https://consumer.test/kit/${view}/`).pathname,
      );
      assert.ok(
        assets.some((path) => path.endsWith(".css")),
        "Kit page must retain the packaged stylesheet",
      );
      for (const path of assets) {
        assert.ok(path.startsWith("/kit/_app/immutable/"));
        assert.ok(
          existsSync(join(root, "build", path.slice("/kit/".length))),
          `Missing Kit asset ${path}`,
        );
      }
    }
    if (browserOutput) cpSync(join(root, "build"), join(browserOutput, "kit"), { recursive: true });
    console.log(
      "Isolated packed SvelteKit consumer prerendered board, tags, map and editor without browser globals or consumer Panda.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
