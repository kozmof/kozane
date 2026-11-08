import { build } from "vite";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
export async function checkCoreBrowser({ temporary, installed, manifest }) {
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  await build({
    configFile: false,
    publicDir: false,
    plugins: [
      {
        name: "packed-core-browser-boundary",
        enforce: "pre",
        resolveId(source) {
          if (
            source.startsWith("node:") ||
            builtins.has(source) ||
            source.startsWith("$") ||
            source.startsWith("@sveltejs/")
          )
            throw new Error(`Core runtime cannot import ${source}`);
        },
      },
    ],
    build: {
      outDir: join(temporary, "browser"),
      emptyOutDir: true,
      lib: {
        entry: Object.fromEntries(
          Object.entries(manifest.exports).map(([key, entry]) => [
            key === "." ? "index" : key.slice(2),
            resolve(installed, entry.import),
          ]),
        ),
        formats: ["es"],
      },
      rollupOptions: {
        external: (id) => id === "uuid" || id === "drizzle-orm" || id.startsWith("drizzle-orm/"),
      },
    },
  });
  console.log(
    "Packed core public runtime, declarations, adapter hooks and browser exports passed in an isolated offline installation.",
  );
}
