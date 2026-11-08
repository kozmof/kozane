import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateMigrations } from "./generate-migrations.mjs";
import { generateSchema } from "./generate-schema.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
await generateMigrations(true);
await generateSchema(true);
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
execFileSync("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
