#!/usr/bin/env node

import { Command } from "commander";
import { init } from "./commands/init.js";
import { dev } from "./commands/dev.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { wcScan, wcCreate } from "./commands/wc.js";
import { projectCreate } from "./commands/project.js";

const program = new Command();

program.name("kozane").description("Local card-based thinking workspace").version("0.1.0");

program
  .command("init")
  .description("Initialize Kozane in the current directory")
  .action(() => init());

program
  .command("dev")
  .description("Start the local Kozane UI")
  .option("--host <host>", "Bind host")
  .option("--port <port>", "Port number")
  .option("--open", "Open browser automatically")
  .action((opts) => dev(opts));

program
  .command("open")
  .description("Start the local Kozane UI and open browser")
  .option("--host <host>", "Bind host")
  .option("--port <port>", "Port number")
  .action((opts) => dev({ ...opts, open: true }));

program
  .command("doctor")
  .description("Check Kozane workspace health")
  .action(() => doctor());

program
  .command("status")
  .description("Show current workspace state")
  .action(() => status());

const project = program.command("project").description("Project management");

project
  .command("create <name>")
  .description("Create a new project in the current workspace")
  .action((name) => projectCreate(name));

const wc = program.command("wc").description("Working copy management");

wc.command("scan")
  .description("Scan filesystem for working copies and sync paths")
  .option("--reattach", "Re-link orphan working copies found on disk")
  .action((opts) => wcScan(opts));

wc.command("create <name>")
  .description("Create a new working copy")
  .option("--scope <scopeId>", "Attach to a scope")
  .option("--dir <path>", "Target directory (default: .kozane/working-copies/<name>)")
  .action((name, opts) => wcCreate(name, opts));

program.parse();
