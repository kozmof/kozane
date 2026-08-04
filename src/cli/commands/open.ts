import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { readApiKey } from "../../lib/server/api-key.js";
import { getMigrationStatus, runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import { projectTable, bundleTable } from "../../db/schema.js";
import { migrationStatusMessage } from "./db.js";
import { isLoopbackHost, normalizeHost } from "../../lib/server/security.js";
import {
  activeServerProcess,
  claimServerState,
  removeServerState,
} from "../../lib/server/runtime-state.js";
import { hyperlink } from "../lib/hyperlink.js";

// dist/cli/commands (or src/cli/commands with tsx) → up 3 → package root
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type OpenOptions = {
  host?: string;
  port?: string;
  open?: boolean;
  allowRemote?: boolean;
  memory?: boolean;
  logRequests?: boolean;
};

export function openBrowser(url: string): void {
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
  const existingServer = activeServerProcess(root);
  if (existingServer) {
    console.error(`Kozane is already running for this workspace (process ${existingServer.pid}).`);
    process.exitCode = 1;
    return;
  }
  const shouldOpen = options.open ?? true;
  const apiKey = readApiKey(root);
  const localBinding = isLoopbackHost(host);
  const remoteBinding = !localBinding;

  if (options.allowRemote && !apiKey) {
    console.error("--allow-remote requires an API key.");
    console.error('Run "kozane api key generate" first.');
    process.exitCode = 1;
    return;
  }

  if (remoteBinding && !options.allowRemote) {
    console.error("Refusing to bind Kozane to non-loopback host " + host + ".");
    console.error("Use --allow-remote to bind remotely (an API key is required).");
    process.exitCode = 1;
    return;
  }

  if (remoteBinding && shouldOpen) {
    console.error("Remote access requires TLS through a reverse proxy.");
    console.error("Run with --no-open, then use the HTTPS URL exposed by your proxy.");
    process.exitCode = 1;
    return;
  }

  let memoryDir: string | undefined;
  let dbURL = dbUrl(resolve(root));
  if (options.memory) {
    memoryDir = mkdtempSync(join(tmpdir(), "kozane-memory-"));
    dbURL = `file:${join(memoryDir, "kozane.db")}`;
    try {
      await runMigrations(dbURL);
      const db = await createDb(dbURL);
      const [project] = await db
        .insert(projectTable)
        .values({ name: ":memory:" })
        .returning({ id: projectTable.id });
      await db
        .insert(bundleTable)
        .values({ projectId: project.id, name: "General", isDefault: true });
    } catch (error) {
      rmSync(memoryDir, { recursive: true, force: true });
      throw error;
    }
  }
  const cleanupMemory = () => {
    if (!memoryDir) return;
    rmSync(memoryDir, { recursive: true, force: true });
    memoryDir = undefined;
  };
  const migrationStatus = options.memory ? null : await getMigrationStatus(dbURL);
  if (migrationStatus && migrationStatus.state !== "current") {
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
  const normalizedHost = normalizeHost(host);
  const urlHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  const url = `http://${urlHost}:${port}`;
  const browserUrl = apiKey ? url + "/?api_key=" + encodeURIComponent(apiKey.apiKey) : url;

  console.log(`Kozane workspace: ${config.name}`);
  const databaseLabel = options.memory
    ? ":memory: (discarded when the server stops)"
    : join(root, ".kozane", "kozane.db");
  console.log("Database: " + databaseLabel);
  if (remoteBinding) {
    console.log("\nRemote access: HTTPS is required; use the URL exposed by your TLS proxy.\n");
  } else {
    console.log("\nLocal UI:\n" + hyperlink(url) + "\n");
  }

  const child = spawn(process.execPath, [serverEntry], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: dbURL,
      KOZANE_WORKSPACE_ROOT: resolve(root),
      ...(options.memory ? { KOZANE_MEMORY_MODE: "1", KOZANE_RUNTIME_DATABASE_URL: dbURL } : {}),
      HOST: host,
      PORT: port,
      KOZANE_LOG_REQUESTS: options.logRequests ? "1" : "0",
      // A local (loopback) server is served over plain http, but the Node adapter
      // assumes https, so SvelteKit's CSRF origin check rejects the login form (a
      // POST) with 403. Give the adapter the exact loopback origin so the check
      // matches the browser. Remote bindings configure ORIGIN / PROTOCOL_HEADER
      // through the reverse proxy instead (see docs), so this only fires locally.
      ...(localBinding ? { ORIGIN: url } : {}),
    },
    stdio: "inherit",
  });

  if (child.pid) {
    const conflictingServer = claimServerState(root, child.pid, {
      memory: options.memory === true,
      databaseUrl: options.memory ? dbURL : undefined,
    });
    if (conflictingServer) {
      child.kill("SIGTERM");
      cleanupMemory();
      console.error(
        `Kozane is already running for this workspace (process ${conflictingServer.pid}).`,
      );
      process.exitCode = 1;
      return;
    }
  }

  let stopping = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  process.once("SIGINT", () => forwardSignal("SIGINT"));

  if (shouldOpen) {
    setTimeout(() => openBrowser(browserUrl), 1000);
  }

  child.on("error", (err) => {
    cleanupMemory();
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    if (child.pid) removeServerState(root, child.pid);
    cleanupMemory();
    process.exit(code ?? 0);
  });
}
