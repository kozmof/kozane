import { build } from "vite";
import { builtinModules } from "node:module";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
await build({
  configFile: false,
  publicDir: false,
  plugins: [
    {
      name: "core-browser-boundary",
      enforce: "pre",
      resolveId(source) {
        if (
          source.startsWith("node:") ||
          builtins.has(source) ||
          source.startsWith("@sveltejs/kit") ||
          source.startsWith("$app/")
        ) {
          throw new Error(`Shared core cannot import ${source}`);
        }
      },
    },
  ],
  build: {
    outDir: "tmp/core-browser",
    emptyOutDir: true,
    lib: { entry: "src/services/index.ts", formats: ["es"], fileName: () => "services.js" },
  },
});
