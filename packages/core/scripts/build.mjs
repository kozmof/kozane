import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
execFileSync("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
