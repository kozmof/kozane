import { execFileSync } from "node:child_process";
import { build } from "vite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
const outdir = "tmp/browser-spike";
await mkdir(outdir, { recursive: true });
const buildId = randomUUID();
for (const name of ["main", "worker"]) {
  await build({
    configFile: false,
    define: { __SPIKE_BUILD_ID__: JSON.stringify(buildId) },
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

const hash = async (name) =>
  createHash("sha256")
    .update(await readFile(`${outdir}/${name}`))
    .digest("hex");
await writeFile(
  `${outdir}/manifest.json`,
  JSON.stringify({
    buildId,
    workerHash: await hash("worker.js"),
    wasmHash: await hash("sqlite3.wasm"),
  }),
);

execFileSync("pnpm", ["exec", "tsx", "scripts/browser-spike/generate-manifest.ts"], {
  stdio: "inherit",
});
