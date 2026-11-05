import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { builtinModules } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const shared = {
  configFile: false,
  publicDir: false,
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("../src/lib", import.meta.url)),
      "styled-system": fileURLToPath(new URL("../styled-system", import.meta.url)),
    },
  },
  plugins: [
    {
      name: "shared-client-boundary",
      enforce: "pre",
      resolveId(source, importer) {
        // Rolldown injects createRequire into its server bundle runtime.
        if (
          this.environment.config.consumer === "server" &&
          source === "node:module" &&
          importer === "\0rolldown/runtime.js"
        )
          return null;
        if (
          source.startsWith("node:") ||
          builtins.has(source) ||
          source.startsWith("$app/") ||
          source.startsWith("$env/") ||
          source === "@sveltejs/kit" ||
          source.startsWith("@sveltejs/kit/") ||
          source.includes("/routes/")
        ) {
          throw new Error(`Shared client cannot import ${source} from ${importer}`);
        }
      },
    },
    svelte({ configFile: false }),
  ],
};
async function main() {
  await build({
    ...shared,
    build: {
      outDir: "tmp/client-browser",
      emptyOutDir: true,
      lib: {
        entry: "src/lib/client/index.ts",
        formats: ["es"],
        fileName: () => "client.js",
      },
    },
  });

  await build({
    ...shared,
    ssr: { external: ["svelte", "@kozmof/reed"] },
    build: {
      outDir: "tmp/client-ssr",
      emptyOutDir: true,
      ssr: "src/test-utils/client-view-consumer.ts",
      rollupOptions: { output: { entryFileNames: "views.js" } },
    },
  });
  const { renderViews } = await import(new URL("../tmp/client-ssr/views.js", import.meta.url));
  const rendered = await renderViews();
  assert.match(rendered.surface, /Shared editor SSR/);
  assert.match(rendered.surface, /editor-sink/);
  assert.match(rendered.panel, /role="dialog"/);
  assert.match(rendered.panel, /notes\.md/);
  assert.match(rendered.namespaces, /Standalone workspace/);
  assert.match(rendered.namespaces, /href="\/demo\/board\/\?namespaceId=n"/);
  assert.doesNotMatch(rendered.namespaces, /<form/);
  assert.match(rendered.tags, /Standalone tag result/);
  assert.match(rendered.tags, /card=ssr-card/);
  assert.doesNotMatch(rendered.tags, /href="[^"#]*[?&]tag=/);
  console.log("Shared client browser bundle and standalone editor/namespace/tags SSR passed.");
}
try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
