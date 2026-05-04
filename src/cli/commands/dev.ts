import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";

// dist/cli/commands (or src/cli/commands with tsx) → up 3 → package root
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type DevOptions = {
  host?: string;
  port?: string;
  open?: boolean;
};

export function dev(options: DevOptions): void {
  const { root, config } = requireWorkspace();

  const host = options.host ?? config.server.host;
  const port = options.port ?? String(config.server.port);

  const dbURL = dbUrl(resolve(root));

  const vite = join(packageRoot, "node_modules", ".bin", "vite");
  const args = ["dev", "--host", host, "--port", port];
  if (options.open) args.push("--open");

  console.log(`Kozane workspace: ${config.name}`);
  console.log(`Database: ${join(root, ".kozane", "kozane.db")}`);
  console.log(`\nLocal UI:\nhttp://${host}:${port}\n`);

  const child = spawn(vite, args, {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: dbURL, KOZANE_WORKSPACE_ROOT: resolve(root) },
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
