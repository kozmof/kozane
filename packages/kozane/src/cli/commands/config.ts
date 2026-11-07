import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findWorkspaceRoot } from "../../db/internal/config.js";
import { DEFAULT_SERVER_HOST } from "../../lib/constants.js";
import { hyperlink } from "../lib/hyperlink.js";
import { resolvePort } from "../lib/port.js";
import { configFilePath } from "../lib/config-editor/handler.js";
import { createConfigEditorServer } from "../lib/config-editor/server.js";
import { openBrowser } from "./open.js";

// dist/cli/commands (or src/cli/commands with tsx) → up 3 → package root
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Built by `vite.config-editor.ts` as part of `pnpm build`. */
const assetsDir = join(packageRoot, "dist", "config-editor");

type ConfigOpenOptions = {
  port?: string;
  open?: boolean;
};

/**
 * Serve a page for editing `.kozane/config.json`. It binds to loopback only and needs the
 * token in the printed link, because saving rewrites the workspace config. It reads
 * the workspace with `findWorkspaceRoot` rather than `requireWorkspace` so a config with
 * errors can still be opened and fixed.
 */
export function configOpen(options: ConfigOpenOptions): void {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    console.error('No Kozane workspace found. Run "kozane init" first.');
    process.exit(1);
  }

  let port: number;
  try {
    port = resolvePort({ flag: options.port, fallback: 0 });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!existsSync(join(assetsDir, "index.html"))) {
    console.error(`The config page is not built (${assetsDir} is missing).`);
    console.error('Run "pnpm build" or "pnpm build:config-editor" in the Kozane checkout.');
    process.exit(1);
  }

  const host = DEFAULT_SERVER_HOST;
  const token = randomBytes(24).toString("base64url");
  const allowedHosts = new Set<string>();
  const server = createConfigEditorServer({ root, token, allowedHosts, assetsDir });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Choose another with --port.`);
    } else {
      console.error("Config server error:", err.message);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    const actualPort = (server.address() as AddressInfo).port;
    allowedHosts.add(`${host}:${actualPort}`);
    allowedHosts.add(`localhost:${actualPort}`);
    const url = `http://${host}:${actualPort}/?token=${token}`;
    console.log(`Editing ${configFilePath(root)}`);
    console.log(`\nConfig page: ${hyperlink(url)}\n`);
    console.log("Press Ctrl+C to stop.");
    if (options.open !== false) setTimeout(() => openBrowser(url), 300);
  });
}
