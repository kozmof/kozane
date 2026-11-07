import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  ssr: {
    external: [
      "@kozane/core",
      "@kozane/core/database",
      "@kozane/core/schema",
      "@kozane/core/services",
      "@kozane/core/migrations",
    ],
  },
  plugins: [
    sveltekit(),
    {
      name: "node-core-runtime-boundary",
      generateBundle(_options, bundle) {
        if (this.environment.config.consumer !== "server") return;
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          for (const id of Object.keys(chunk.modules)) {
            const normalized = id.replaceAll("\\", "/");
            if (
              normalized.includes("/packages/core/") ||
              normalized.includes("/node_modules/@kozane/core/")
            ) {
              throw new Error("Node server must use installed core rather than bundle " + id);
            }
          }
        }
      },
    },
  ],
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
});
