/** Workspace-level commands: init, open, net, doctor, config, status, and api. */
import { Command } from "commander";

import { init } from "../commands/init.js";
import { open } from "../commands/open.js";
import { ssg, ssgPreview } from "../commands/ssg.js";
import { doctor, doctorConfig } from "../commands/doctor.js";
import { configOpen } from "../commands/config.js";
import { status } from "../commands/status.js";
import { apiGenerate, apiRefresh } from "../commands/api.js";
import {
  DEFAULT_PREVIEW_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "../../lib/constants.js";

export function registerWorkspaceCommands(program: Command): void {
  program
    .command("init")
    .description("Initialize Kozane in the current directory")
    .action(() => init());

  program
    .command("open")
    .description("Start the local Kozane UI and open browser")
    .option("--host <host>", "Bind host (or KOZANE_HOST; default: from config)")
    .option("--port <port>", `Port number (or KOZANE_PORT; default: ${DEFAULT_SERVER_PORT})`)
    .option("--memory", "Use a temporary in-memory database for this server run")
    .option("--log-requests", "Log each HTTP request")
    .option("--allow-remote", "Bind for access through an HTTPS reverse proxy (requires --no-open)")
    .option("--no-open", "Start server without opening browser")
    .action((opts) => open(opts));

  const net = program.command("net").description("Networking and publishing");

  const ssgCommand = net
    .command("ssg")
    .description("Export the workspace as a static, read-only site (for GitHub Pages, etc.)");

  ssgCommand
    .command("generate")
    .description("Export the workspace as a static, read-only site (for GitHub Pages, etc.)")
    .option("--out <dir>", "Output directory (default: ./site)")
    .option("--base <path>", "Base path when hosted under a subdirectory, e.g. /kozane")
    .option(
      "--include-scoped-files",
      "Include scopes, taskspaces, and their files (read-only) in the export",
    )
    .action((opts) => ssg(opts));

  ssgCommand
    .command("preview")
    .description("Serve a previously exported static site over HTTP")
    .option("--out <dir>", "Directory to serve (default: ./site)")
    .option("--base <path>", "Base path the site was built with, e.g. /kozane")
    .option("--host <host>", `Bind host (or KOZANE_PREVIEW_HOST; default: ${DEFAULT_SERVER_HOST})`)
    .option(
      "--port <port>",
      `Port number (or KOZANE_PREVIEW_PORT; default: ${DEFAULT_PREVIEW_PORT})`,
    )
    .option("--no-open", "Start the server without opening the browser")
    .action((opts) => ssgPreview(opts));

  // Run workspace health checks with `doctor` and detailed checks with its subcommands.
  const doctorCommand = program
    .command("doctor")
    .description("Check Kozane workspace health")
    .action(() => doctor());

  doctorCommand
    .command("config")
    .description("Check .kozane/config.json for missing keys, unknown keys, and invalid values")
    .option("--strict", "Exit non-zero for unknown keys as well as errors")
    .action((opts) => doctorConfig(opts));

  const config = program.command("config").description("Workspace config");
  config
    .command("open")
    .description("Edit .kozane/config.json in the browser")
    .option("--port <port>", "Port number (default: a free port)")
    .option("--no-open", "Start the server without opening the browser")
    .action((opts) => configOpen(opts));

  program
    .command("status")
    .description("Show current workspace state")
    .action(() => status());

  const api = program.command("api").description("API management");
  const apiKey = api.command("key").description("API key lifecycle");

  apiKey
    .command("generate")
    .description("Generate an API key for this workspace")
    .action(apiGenerate);
  apiKey.command("refresh").description("Replace the current API key").action(apiRefresh);
}
