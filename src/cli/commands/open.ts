import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { getMigrationStatus } from "../lib/db.js";
import { migrationStatusMessage } from "./db.js";

// dist/cli/commands (or src/cli/commands with tsx) → up 3 → package root
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type OpenOptions = {
  host?: string;
  port?: string;
  open?: boolean;
};

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open ${url}`
      : process.platform === "win32"
        ? `start ${url}`
        : `xdg-open ${url}`;
  exec(cmd);
}

export async function open(options: OpenOptions): Promise<void> {
  const { root, config } = requireWorkspace();

  const host = options.host ?? config.server.host;
  const port = options.port ?? String(config.server.port);
  const shouldOpen = options.open ?? true;

  const dbURL = dbUrl(resolve(root));
  const migrationStatus = await getMigrationStatus(dbURL);
  if (migrationStatus.state !== "current") {
    console.error("Kozane database needs attention before the UI can start.");
    console.error(migrationStatusMessage(migrationStatus));
    if (migrationStatus.state === "pending") {
      console.error("\nRun: kozane db migrate");
    } else {
      console.error("\nRun: kozane db status");
      console.error("Run: kozane doctor");
    }
    process.exit(1);
  }

  const serverEntry = join(packageRoot, "build", "index.js");
  const url = `http://${host}:${port}`;

  console.log(`Kozane workspace: ${config.name}`);
  console.log(`Database: ${join(root, ".kozane", "kozane.db")}`);
  console.log(`\nLocal UI:\n${url}\n`);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: dbURL,
      KOZANE_WORKSPACE_ROOT: resolve(root),
      HOST: host,
      PORT: port,
    },
    stdio: "inherit",
  });

  if (shouldOpen) {
    setTimeout(() => openBrowser(url), 1000);
  }

  child.on("error", (err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
