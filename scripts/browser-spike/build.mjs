import { build } from "vite";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
const outdir = "tmp/browser-spike";
await mkdir(outdir, { recursive: true });
for (const name of ["main", "worker"]) {
  await build({
    configFile: false,
    publicDir: false,
    build: {
      outDir: outdir,
      emptyOutDir: false,
      lib: {
        entry: `scripts/browser-spike/${name}.ts`,
        formats: ["es"],
        fileName: () => `${name}.js`,
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}
await copyFile("node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm", `${outdir}/sqlite3.wasm`);
await writeFile(
  `${outdir}/index.html`,
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'"><title>SQLite feasibility spike</title><body>Running database checks…<script type="module" src="./main.js"></script>`,
);
