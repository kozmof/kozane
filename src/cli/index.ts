#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";

const _require = createRequire(import.meta.url);
const { version: _version } = _require("../../package.json") as { version: string };
import { init } from "./commands/init.js";
import { open } from "./commands/open.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { wcScan, wcCreate } from "./commands/wc.js";
import { projectCreate, projectDelete, projectList } from "./commands/project.js";
import { dbExport, dbImport, dbMigrate, dbRestore, dbStatus } from "./commands/db.js";
import { cardAdd, cardList } from "./commands/card.js";

const program = new Command();

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new InvalidArgumentError("Must be an integer.");
  return parsed;
}

program.name("kozane").description("Local card-based thinking workspace").version(_version);

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
  .description("Delete a project by ID or short ID")
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

db.command("restore [file]")
  .description("Restore database from a backup (defaults to most recent)")
  .action((file) => dbRestore(file));

const wc = program.command("wc").description("Working copy management");

wc.command("scan")
  .description("Scan filesystem for working copies (dry run by default)")
  .option("--apply", "Write changes to the database")
  .option("--reattach", "Re-link orphan working copies found on disk (requires --apply)")
  .option("--cleanup", "Delete DB records for missing working copies (requires --apply)")
  .action((opts) => wcScan(opts));

wc.command("create <name>")
  .description("Create a new working copy")
  .option(
    "--scope <scopeId>",
    "Attach to a scope ID or short ID (required unless --no-scope is given)",
  )
  .option("--no-scope", "Create without a scope")
  .option(
    "--project <projectId>",
    "Project ID or short ID (required when workspace has multiple projects)",
  )
  .option("--dir <path>", "Target directory (default: <projectRoot>/<name>)")
  .action((name, opts) => wcCreate(name, opts));

const card = program.command("card").description("Card management");

card
  .command("add <content>")
  .description("Add a card to a project")
  .option("--project <projectId>", "Project ID or short ID to add the card to")
  .option("--bundle <bundleId>", "Bundle ID or short ID (defaults to General)")
  .option("--x <number>", "Horizontal card position", integer)
  .option("--y <number>", "Vertical card position", integer)
  .action((content, opts) => cardAdd(content, opts));

card
  .command("list")
  .description("List cards in a project")
  .option("--project <projectId>", "Project ID or short ID whose cards to list")
  .option("--bundle <bundleId>", "Only list cards in this bundle ID or short ID")
  .action((opts) => cardList(opts));

program.parse();
