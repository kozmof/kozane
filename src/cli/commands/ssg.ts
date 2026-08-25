import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { requireCurrentMigrations } from "../lib/db.js";
import { createStaticServer } from "../lib/static-server.js";
import { openBrowser } from "./open.js";
import { hyperlink } from "../lib/hyperlink.js";
import { resolvePort } from "../lib/port.js";
import { DEFAULT_PREVIEW_PORT, DEFAULT_SERVER_HOST } from "../../lib/constants.js";

// dist/cli/commands (or src/cli/commands with tsx) → up 3 → package root
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type SsgOptions = {
  out?: string;
  base?: string;
  includeScopedFiles?: boolean;
};

// GitHub Pages serves project sites under /<repo>/, so links need a base path.
// SvelteKit requires it to start with "/" and not end with one.
function normalizeBase(raw: string | undefined): string {
  if (!raw || raw === "/") return "";
  let base = raw.startsWith("/") ? raw : "/" + raw;
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

export async function ssg(options: SsgOptions): Promise<void> {
  const { root, config } = requireWorkspace();

  const base = normalizeBase(options.base);

  const dbURL = dbUrl(resolve(root));
  await requireCurrentMigrations(dbURL, "it can be exported");

  const outDir = resolve(process.cwd(), options.out ?? "site");
  const buildDir = join(packageRoot, "build-ssg");
  const viteBin = join(packageRoot, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    console.error("Static export requires the Kozane source build toolchain.");
    console.error("Run this from a cloned repository after 'pnpm install'.");
    process.exit(1);
  }

  console.log(`Kozane workspace: ${config.name}`);
  console.log(`Database: ${join(root, ".kozane", "kozane.db")}`);
  console.log(base ? `Base path: ${base}` : "Base path: / (site root)");
  console.log(
    options.includeScopedFiles
      ? "Scopes and taskspace files: included (read-only)"
      : "Scopes and taskspace files: excluded (pass --include-scoped-files to include them)",
  );
  console.log("\nBuilding static read-only site...\n");

  const exitCode = await new Promise<number>((resolvePromise) => {
    const child = spawn(process.execPath, [viteBin, "build"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        KOZANE_SSG: "1",
        KOZANE_READONLY: "1",
        KOZANE_SSG_BASE: base,
        KOZANE_SSG_INCLUDE_SCOPED_FILES: options.includeScopedFiles ? "1" : "",
        DATABASE_URL: dbURL,
        KOZANE_WORKSPACE_ROOT: resolve(root),
      },
      stdio: "inherit",
    });
    child.on("error", (err) => {
      console.error("Failed to run build:", err.message);
      resolvePromise(1);
    });
    child.on("exit", (code) => resolvePromise(code ?? 0));
  });

  if (exitCode !== 0) {
    console.error("\nStatic export failed.");
    process.exit(exitCode);
  }

  // Publish the freshly built site into the workspace-relative output directory.
  rmSync(outDir, { recursive: true, force: true });
  cpSync(buildDir, outDir, { recursive: true });
  // GitHub Pages runs Jekyll by default, which strips SvelteKit's _app directory.
  writeFileSync(join(outDir, ".nojekyll"), "");

  console.log(`\nStatic site written to ${outDir}`);
  console.log(`\nPreview it locally with: kozane net ssg preview${base ? ` --base ${base}` : ""}`);
  console.log("\nTo publish on GitHub Pages:");
  console.log(`  1. Commit the contents of ${options.out ?? "site"}/ to a branch (or gh-pages).`);
  console.log("  2. In the repository settings, enable Pages for that branch.");
  if (base) {
    console.log(`  3. The site expects to be served under ${base}/.`);
  }
}

type SsgPreviewOptions = {
  out?: string;
  base?: string;
  host?: string;
  port?: string;
  open?: boolean;
};

export async function ssgPreview(options: SsgPreviewOptions): Promise<void> {
  const outDir = resolve(process.cwd(), options.out ?? "site");
  if (!existsSync(join(outDir, "index.html"))) {
    console.error(`No exported site found at ${outDir}.`);
    console.error("Run 'kozane net ssg generate' first, or pass --out <dir>.");
    process.exit(1);
  }

  const envHost = process.env.KOZANE_PREVIEW_HOST?.trim();
  const host = options.host ?? (envHost ? envHost : DEFAULT_SERVER_HOST);
  let port: number;
  try {
    port = resolvePort({
      flag: options.port,
      env: process.env.KOZANE_PREVIEW_PORT,
      envName: "KOZANE_PREVIEW_PORT",
      fallback: DEFAULT_PREVIEW_PORT,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const base = options.base ?? "";
  const server = createStaticServer(outDir, base);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Choose another with --port.`);
    } else {
      console.error("Preview server error:", err.message);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}${base ? base.replace(/\/$/, "") + "/" : "/"}`;
    console.log(`Previewing ${outDir}`);
    console.log(`\nStatic preview: ${hyperlink(url)}\n`);
    console.log("Press Ctrl+C to stop.");
    if (options.open !== false) setTimeout(() => openBrowser(url), 300);
  });
}
