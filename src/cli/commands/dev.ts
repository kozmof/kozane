import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { requireProject } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";

type DevOptions = {
  host?: string;
  port?: string;
  open?: boolean;
};

export function dev(options: DevOptions): void {
  const { root, config } = requireProject();

  const host = options.host ?? config.server.host;
  const port = options.port ?? String(config.server.port);

  const dbURL = dbUrl(resolve(root));

  const args = ["vite", "dev", "--host", host, "--port", port];
  if (options.open) args.push("--open");

  console.log(`Kozane project: ${config.name}`);
  console.log(`Database: ${join(root, ".kozane", "kozane.db")}`);
  console.log(`\nLocal UI:\nhttp://${host}:${port}\n`);

  const child = spawn("npx", args, {
    cwd: resolve(root),
    env: { ...process.env, DATABASE_URL: dbURL },
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
