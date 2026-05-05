#!/usr/bin/env node

import { Command } from "commander";
import { init } from "./commands/init.js";
import { open } from "./commands/open.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { wcScan, wcCreate } from "./commands/wc.js";
import { projectCreate, projectDelete, projectList } from "./commands/project.js";
import { dbExport, dbImport, dbMigrate, dbStatus } from "./commands/db.js";

const program = new Command();

program.name("kozane").description("Local card-based thinking workspace").version("0.1.0");

program
  .command("init")
  .description("Initialize Kozane in the current directory")
  .action(() => init());

program
  .command("open")
  .description("Start the local Kozane UI and open browser")
  .option("--host <host>", "Bind host")
  .option("--port <port>", "Port number")
  .option("--no-open", "Start server without opening browser")
  .action((opts) => open(opts));

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
  .command("list")
  .description("List all projects in the current workspace")
  .action(() => projectList());

project
  .command("create <name>")
  .description("Create a new project in the current workspace")
  .action((name) => projectCreate(name));

project
  .command("delete <id>")
  .description("Delete a project by ID")
  .action((id) => projectDelete(id));

const db = program.command("db").description("Database management");

db.command("status")
  .description("Show workspace database migration status")
  .action(() => dbStatus());

db.command("migrate")
  .description("Back up and migrate the workspace database")
  .action(() => dbMigrate());

db.command("export [file]")
  .description("Export workspace database data as JSON")
  .option("--compact", "Write compact JSON instead of formatted JSON")
  .action((file, opts) => dbExport(file, { pretty: !opts.compact }));

db.command("import <file>")
  .description("Import workspace database data from JSON")
  .option("--force", "Replace existing workspace database data")
  .action((file, opts) => dbImport(file, opts));

const wc = program.command("wc").description("Working copy management");

wc.command("scan")
  .description("Scan filesystem for working copies (dry run by default)")
  .option("--apply", "Write changes to the database")
  .option("--reattach", "Re-link orphan working copies found on disk (requires --apply)")
  .option("--cleanup", "Delete DB records for missing working copies (requires --apply)")
  .action((opts) => wcScan(opts));

wc.command("create <name>")
  .description("Create a new working copy")
  .option("--scope <scopeId>", "Attach to a scope (required unless --no-scope is given)")
  .option("--no-scope", "Create without a scope")
  .option("--dir <path>", "Target directory (default: <projectRoot>/<name>)")
  .action((name, opts) => wcCreate(name, opts));

program.parse();
