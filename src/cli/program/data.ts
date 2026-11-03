/** Database and taskspace commands. */
import { Command } from "commander";

import { taskspaceScan, taskspaceCreate, taskspaceList } from "../commands/taskspace.js";
import { dbExport, dbImport, dbMigrate, dbRestore, dbStatus } from "../commands/db.js";

export function registerDataCommands(program: Command): void {
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
    .option(
      "--allow-absolute-paths",
      "Accept taskspaces whose directories are outside the workspace",
    )
    .action((file, opts) => dbImport(file, opts));

  db.command("restore [file]")
    .description("Restore database from a backup (defaults to most recent)")
    .action((file) => dbRestore(file));

  const taskspace = program.command("taskspace").description("Taskspace management");

  taskspace
    .command("list")
    .description("List every taskspace in the workspace with its namespace and scope")
    .option("--namespace <namespaceId>", "Show only the taskspaces this namespace's board draws")
    .action((opts) => taskspaceList(opts));

  taskspace
    .command("scan")
    .description("Scan filesystem for taskspaces (dry run by default)")
    .option("--apply", "Write changes to the database")
    .option("--reattach", "Re-link orphan taskspaces found on disk (requires --apply)")
    .option("--cleanup", "Delete DB records for missing taskspaces (requires --apply)")
    .option(
      "--namespace <namespaceId>",
      "Namespace for reattached taskspaces (default: each marker's namespace, or the workspace default if it was deleted; requires --reattach)",
    )
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
      "--namespace <namespaceId>",
      "Namespace ID or short ID (required when workspace has multiple namespaces)",
    )
    .option(
      "--dir <path>",
      "Target directory (default: <workspaceRoot>/taskspaces/<namespace>/<name>)",
    )
    .action((name, opts) => taskspaceCreate(name, opts));
}
