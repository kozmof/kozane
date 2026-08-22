#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";

const _require = createRequire(import.meta.url);
const { version: _version } = _require("../../package.json") as { version: string };
import { init } from "./commands/init.js";
import { open } from "./commands/open.js";
import { ssg, ssgPreview } from "./commands/ssg.js";
import { doctor, doctorConfig } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { taskspaceScan, taskspaceCreate, taskspaceList } from "./commands/taskspace.js";
import { projectCreate, projectDefault, projectDelete, projectList } from "./commands/project.js";
import { dbExport, dbImport, dbMigrate, dbRestore, dbStatus } from "./commands/db.js";
import {
  cardAdd,
  cardList,
  cardNearest,
  cardSetLayer,
  cardShow,
  cardSquash,
} from "./commands/card.js";
import { scopeAdd, scopeDelete, scopeList } from "./commands/scope.js";
import { layerAdd, layerDelete, layerList, layerMove, layerRename } from "./commands/layer.js";
import { apiGenerate, apiRefresh } from "./commands/api.js";
import {
  DEFAULT_PREVIEW_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "../lib/constants.js";

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
  .action((opts) => ssg(opts));

ssgCommand
  .command("preview")
  .description("Serve a previously exported static site over HTTP")
  .option("--out <dir>", "Directory to serve (default: ./site)")
  .option("--base <path>", "Base path the site was built with, e.g. /kozane")
  .option("--host <host>", `Bind host (or KOZANE_PREVIEW_HOST; default: ${DEFAULT_SERVER_HOST})`)
  .option("--port <port>", `Port number (or KOZANE_PREVIEW_PORT; default: ${DEFAULT_PREVIEW_PORT})`)
  .option("--no-open", "Start the server without opening the browser")
  .action((opts) => ssgPreview(opts));

// `doctor` runs the workspace health check on its own, and hosts the deeper per-area
// checks as subcommands.
const doctorCommand = program
  .command("doctor")
  .description("Check Kozane workspace health")
  .action(() => doctor());

doctorCommand
  .command("config")
  .description("Check .kozane/config.json for missing keys, unknown keys, and invalid values")
  .option("--strict", "Exit non-zero for unknown keys as well as errors")
  .action((opts) => doctorConfig(opts));

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

project
  .command("default <id>")
  .alias("set-default")
  .description("Set the default project used when --project is omitted")
  .action((id) => projectDefault(id));

const scope = program.command("scope").description("Scope management");

scope
  .command("list")
  .description("List every scope in the workspace and the projects each one reaches")
  .option("--project <projectId>", "Show only the scopes this project's board draws")
  .action((opts) => scopeList(opts));

scope
  .command("add <name>")
  .description("Add a cross-project card scope")
  .action((name) => scopeAdd(name));

scope
  .command("delete <id>")
  .description("Delete a scope by ID or short ID")
  .action((id) => scopeDelete(id));

const layer = program.command("layer").description("Layer management");

layer
  .command("list")
  .description("List a project's layers, bottom to top")
  .option("--project <projectId>", "Project ID or short ID whose layers to list")
  .action((opts) => layerList(opts));

layer
  .command("add <name>")
  .description("Add a layer on top of a project's existing layers")
  .option("--project <projectId>", "Project ID or short ID to add the layer to")
  .action((name, opts) => layerAdd(name, opts));

layer
  .command("rename <layer> <name>")
  .description("Rename a layer by name, ID, or short ID — an exact name wins")
  .option("--project <projectId>", "Project ID or short ID the layer belongs to")
  .action((id, name, opts) => layerRename(id, name, opts));

layer
  .command("move <layer> <direction>")
  .description("Move a layer one step up or down the stack, by name, ID, or short ID")
  .option("--project <projectId>", "Project ID or short ID the layer belongs to")
  .action((id, direction, opts) => layerMove(id, direction, opts));

layer
  .command("delete <layer>")
  .description("Delete a layer by name, ID, or short ID, moving its cards to the default layer")
  .option("--project <projectId>", "Project ID or short ID the layer belongs to")
  .action((id, opts) => layerDelete(id, opts));

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

const taskspace = program.command("taskspace").description("Taskspace management");

taskspace
  .command("list")
  .description("List every taskspace in the workspace with its project and scope")
  .option("--project <projectId>", "Show only the taskspaces this project's board draws")
  .action((opts) => taskspaceList(opts));

taskspace
  .command("scan")
  .description("Scan filesystem for taskspaces (dry run by default)")
  .option("--apply", "Write changes to the database")
  .option("--reattach", "Re-link orphan taskspaces found on disk (requires --apply)")
  .option("--cleanup", "Delete DB records for missing taskspaces (requires --apply)")
  .action((opts) => taskspaceScan(opts));

taskspace
  .command("create <name>")
  .description("Create a new taskspace")
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
  .action((name, opts) => taskspaceCreate(name, opts));

const card = program.command("card").description("Card management");

card
  .command("add <content>")
  .description("Add a card to a project")
  .option("--project <projectId>", "Project ID or short ID to add the card to")
  .option("--bundle <bundleId>", "Bundle ID or short ID (defaults to General)")
  .option("--scope <scopeId>", "Add the card to a scope ID or short ID")
  .option(
    "--layer <layer>",
    "Layer name, ID, or short ID — an exact name wins (defaults to the default layer)",
  )
  .option("--x <number>", "Horizontal card position", integer)
  .option("--y <number>", "Vertical card position", integer)
  .action((content, opts) => cardAdd(content, opts));

card
  .command("squash [content]")
  .description("Split an argument or stdin with a regex and add each part as a card")
  .option("--project <projectId>", "Project ID or short ID to add the cards to")
  .option("--bundle <bundleId>", "Bundle ID or short ID (defaults to General)")
  .option("--scope <scopeId>", "Add the cards to a scope ID or short ID")
  .option(
    "--layer <layer>",
    "Layer name, ID, or short ID — an exact name wins (defaults to the default layer)",
  )
  .option(
    "--pattern <regex>",
    "JavaScript regex used to split cards (default: period-space, 。, or blank line)",
  )
  .action((content, opts) => cardSquash(content, opts));

card
  .command("show <cardId>")
  .description("Show a card content by full or short ID")
  .action((cardId) => cardShow(cardId));

card
  .command("layer <cardId> <layer>")
  .description("Move a card to another layer of its project, by layer ID, short ID, or name")
  .action((cardId, layer) => cardSetLayer(cardId, layer));

card
  .command("nearest <cardId>")
  .description("List cards in the same project, nearest to the specified card first")
  .action((cardId) => cardNearest(cardId));

const cardListCommand = card
  .command("list")
  .description("List cards in a project or taskspace scope")
  .option("--project <projectId>", "Project ID or short ID whose cards to list")
  .option("--bundle <bundleId>", "Only list cards in this bundle ID or short ID")
  .option("--taskspace <path>", "Taskspace directory or .taskspace.json path")
  .action((opts) => cardList(opts));

cardListCommand.addHelpText(
  "after",
  `
Taskspace behavior:
  If the current directory contains .taskspace.json, this command automatically
  lists cards for that taskspace when --project and --bundle are omitted.

  Use --taskspace <path> from elsewhere. <path> may be either the taskspace
  directory or its .taskspace.json file. A scoped taskspace lists current
  scope members. A no-scope or deleted-scope taskspace lists cards associated
  directly with that taskspace and prints a status notice.

Examples:
  kozane card list
  kozane card list --taskspace ./draft
  kozane card list --taskspace ./draft/.taskspace.json
`,
);

program.parse();
