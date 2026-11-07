import { runPanda, buildStyles } from "./styles.mjs";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
runPanda(root, packageRoot, ["codegen"]);
const generated = join(packageRoot, "src/styles/generated");
await rm(generated, { recursive: true, force: true });
await mkdir(generated, { recursive: true });
// Copy generated runtime assets unchanged. Authoring augmentation barrels stay private.
for (const name of ["helpers.js", "css", "tokens", "types"]) {
  await cp(join(packageRoot, "styled-system", name), join(generated, name), {
    recursive: true,
    filter(source) {
      const relative = source
        .slice(join(packageRoot, "styled-system").length + 1)
        .replaceAll("\\", "/");
      if (["types/index.d.ts", "types/global.d.ts"].includes(relative)) return false;
      return !relative.startsWith("css/") || !relative.endsWith(".d.ts");
    },
  });
}
await cp(join(packageRoot, "styles/runtime-css.d.ts"), join(generated, "css/css.d.ts"));
execFileSync(
  "pnpm",
  ["exec", "svelte-package", "--input", "src", "--output", "dist", "--tsconfig", "tsconfig.json"],
  { cwd: packageRoot, stdio: "inherit" },
);
await buildStyles(root, packageRoot);
