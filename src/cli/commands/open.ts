import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { readApiKey } from "../../lib/server/api-key.js";
import { getMigrationStatus } from "../lib/db.js";
import { migrationStatusMessage } from "./db.js";

// dist/cli/commands (or src/cli/commands with tsx) → up 3 → package root
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type OpenOptions = {
  host?: string;
  port?: string;
  open?: boolean;
  allowRemote?: boolean;
};

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    execFile("open", [url]);
  } else if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url]);
  } else {
    execFile("xdg-open", [url]);
  }
}

export async function open(options: OpenOptions): Promise<void> {
  const { root, config } = requireWorkspace();

  const host = options.host ?? config.server.host;
  const port = options.port ?? String(config.server.port);
  const shouldOpen = options.open ?? true;
  const apiKey = readApiKey(root);

  if (options.allowRemote && !apiKey) {
    console.error("--allow-remote requires an API key.");
    console.error('Run "kozane api key generate" first.');
    process.exitCode = 1;
    return;
  }

  if (!isLoopbackHost(host) && !options.allowRemote) {
    console.error("Refusing to bind Kozane to non-loopback host " + host + ".");
    console.error("Use --allow-remote to bind remotely (an API key is required).");
    process.exitCode = 1;
    return;
  }

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
  const browserUrl = apiKey ? url + "/?api_key=" + encodeURIComponent(apiKey.apiKey) : url;

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
    setTimeout(() => openBrowser(browserUrl), 1000);
  }

  child.on("error", (err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
