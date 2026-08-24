import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { readApiKeyResult } from "../../lib/server/api-key.js";
import { requireCurrentMigrations, runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import { projectTable, bundleTable, layerTable } from "../../db/schema.js";
import { isLoopbackHost, normalizeHost } from "../../lib/server/security.js";
import {
  activeServerProcess,
  claimServerState,
  removeServerState,
  writeServerState,
} from "../../lib/server/runtime-state.js";
import { hyperlink } from "../lib/hyperlink.js";
import { resolvePort } from "../lib/port.js";
import { DEFAULT_LAYER_NAME, DEFAULT_SERVER_PORT } from "../../lib/constants.js";

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

/**
 * Opens the workspace in the user's browser, and says so when it cannot.
 *
 * `execFile` without a callback swallows the spawn error — a missing `xdg-open` produces
 * no throw and no output — so a headless box got a URL printed a second earlier, then
 * silence, with nothing connecting the two. The fallback names the URL again rather than
 * only reporting the failure, because typing it in is the whole of the recovery.
 */
export function openBrowser(url: string): void {
  const onFailure = (error: Error | null) => {
    if (!error) return;
    console.error(`\nCould not open a browser automatically (${error.message}).`);
    console.error(`Open this URL yourself:\n${url}\n`);
  };

  if (process.platform === "darwin") {
    execFile("open", [url], onFailure);
  } else if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url], onFailure);
  } else {
    execFile("xdg-open", [url], onFailure);
  }
}

export async function open(options: OpenOptions): Promise<void> {
  const { root, config } = requireWorkspace();

  const envHost = process.env.KOZANE_HOST?.trim();
  const host = options.host ?? (envHost ? envHost : config.server.host);
  let port: string;
  try {
    port = String(
      resolvePort({
        flag: options.port,
        env: process.env.KOZANE_PORT,
        config: config.server.port,
        fallback: DEFAULT_SERVER_PORT,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const existingServer = activeServerProcess(root);
  if (existingServer) {
    console.error(`Kozane is already running for this workspace (process ${existingServer.pid}).`);
    process.exitCode = 1;
    return;
  }
  const shouldOpen = options.open ?? true;
  // Read as a result rather than thrown: a malformed `api.json` otherwise leaves the
  // command as an unhandled rejection and a stack trace, where every other way `open`
  // refuses — a port in use, a workspace already served — prints a line and exits 1.
  const apiKeyResult = readApiKeyResult(root);
  if (!apiKeyResult.ok) {
    console.error(apiKeyResult.message);
    console.error('Fix the file, or run "kozane api key refresh" to replace it.');
    process.exitCode = 1;
    return;
  }
  const apiKey = apiKeyResult.key;
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
        .values({ name: ":memory:", isDefault: true })
        .returning({ id: projectTable.id });
      await db
        .insert(bundleTable)
        .values({ projectId: project.id, name: "General", isDefault: true });
      await db
        .insert(layerTable)
        .values({ projectId: project.id, name: DEFAULT_LAYER_NAME, isDefault: true });
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
  // A memory server builds and migrates its own database a few lines above, so there is
  // nothing here that could be behind.
  if (!options.memory) await requireCurrentMigrations(dbURL, "the UI can start");

  const serverEntry = join(packageRoot, "build", "index.js");
  const normalizedHost = normalizeHost(host);
  const urlHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  const url = `http://${urlHost}:${port}`;
  const browserUrl = apiKey ? url + "/?api_key=" + encodeURIComponent(apiKey.apiKey) : url;

  // The workspace is reserved before the server is started rather than after it. The
  // reservation is the authority on who serves this workspace, and consulting it second
  // meant two `kozane open` runs could both pass the check above, both spawn a server, and
  // one of them be killed once already listening — a window a whole process launch wide.
  // `activeServerProcess` above stays: it fails early, before a temporary database has been
  // built, and this is the one that actually decides.
  const conflictingServer = claimServerState(root, process.pid, {
    memory: options.memory === true,
    databaseUrl: options.memory ? dbURL : undefined,
  });
  if (conflictingServer) {
    cleanupMemory();
    console.error(
      `Kozane is already running for this workspace (process ${conflictingServer.pid}).`,
    );
    process.exitCode = 1;
    return;
  }

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

  // Re-pointed at the server itself now that it has a pid. The reservation was taken above
  // in this process's name, which held the workspace across the spawn; from here the
  // process that has to be found alive is the one actually serving it, and it is the one
  // `removeServerState` below is matched against.
  if (child.pid) {
    writeServerState(root, child.pid, {
      memory: options.memory === true,
      databaseUrl: options.memory ? dbURL : undefined,
    });
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
    // The reservation is held from before the spawn now, so a server that never started has
    // to give it back — under whichever pid it ended up recorded against.
    removeServerState(root, child.pid ?? process.pid);
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
