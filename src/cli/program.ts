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
import {
  namespaceCreate,
  namespaceDefault,
  namespaceDelete,
  namespaceList,
} from "./commands/namespace.js";
import { dbExport, dbImport, dbMigrate, dbRestore, dbStatus } from "./commands/db.js";
import {
  cardAdd,
  cardDelete,
  cardEdit,
  cardGlue,
  cardList,
  cardMove,
  cardNearest,
  cardSetPartition,
  cardSetLayer,
  cardSetNamespace,
  cardShow,
  cardSquash,
  cardUnglue,
} from "./commands/card.js";
import { CARD_SORT_KEYS, isCardSortKey, type CardSortKey } from "./lib/card-sort.js";
import { fail } from "./lib/workspace-command.js";
import {
  scopeAdd,
  scopeAddCards,
  scopeDelete,
  scopeList,
  scopeRemoveCards,
} from "./commands/scope.js";
import { tagList, tagShow } from "./commands/tag.js";
import { layerAdd, layerDelete, layerList, layerMove, layerRename } from "./commands/layer.js";
import { apiGenerate, apiRefresh } from "./commands/api.js";
import { partitionAdd, partitionDelete, partitionList } from "./commands/partition.js";
import { warpAdd, warpDelete, warpList } from "./commands/warp.js";
import {
  DEFAULT_PREVIEW_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "../lib/constants.js";

// Commander argument parsers. Module scope rather than inside the builder: they close over
// nothing in it, and a builder that can be called twice should not mint two copies of each.

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new InvalidArgumentError("Must be an integer.");
  return parsed;
}

function cardPosition(value: string): number | string {
  if (/^current[+-]\d+$/.test(value)) return value;
  try {
    return integer(value);
  } catch {
    throw new InvalidArgumentError(
      'Must be an integer or relative position such as "current+100".',
    );
  }
}

function cardSortKey(value: string): CardSortKey {
  if (!isCardSortKey(value))
    throw new InvalidArgumentError(`Must be one of: ${CARD_SORT_KEYS.join(", ")}.`);
  return value;
}

/**
 * The command tree, built rather than built-and-run.
 *
 * Split out of `index.ts`, which used to declare all of this and then call `parse()` at
 * module scope — so the only way to see what commands exist was to run one. `spec.test.ts`
 * walks what this returns and checks it against `spec/cli.md`, which is 1,500 lines of
 * specification that nothing previously held to the code.
 *
 * `index.ts` is now the entry and nothing else: it builds this and parses argv.
 */
export function buildProgram(): Command {
  const program = new Command();

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

  const namespace = program.command("namespace").description("Namespace management");

  namespace
    .command("list")
    .description("List all namespaces in the current workspace")
    .action(() => namespaceList());

  namespace
    .command("create <name>")
    .description("Create a new namespace in the current workspace")
    .action((name) => namespaceCreate(name));

  namespace
    .command("delete <id>")
    .description("Delete a namespace by ID or short ID")
    .action((id) => namespaceDelete(id));

  namespace
    .command("default <id>")
    .alias("set-default")
    .description("Set the default namespace used when --namespace is omitted")
    .action((id) => namespaceDefault(id));

  const partition = program.command("partition").description("Partition management");

  partition
    .command("list")
    .description("List a namespace's partitions")
    .option("--namespace <namespaceId>", "Namespace ID or short ID whose partitions to list")
    .action((opts) => partitionList(opts));

  partition
    .command("add <name>")
    .description("Add a partition to a namespace")
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the partition to")
    .action((name, opts) => partitionAdd(name, opts));

  partition
    .command("delete <partitionId>")
    .description("Delete a partition and move its cards to the default partition")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the partition belongs to")
    .action((id, opts) => partitionDelete(id, opts));

  const scope = program.command("scope").description("Scope management");

  scope
    .command("list")
    .description("List every scope in the workspace and the namespaces each one reaches")
    .option("--namespace <namespaceId>", "Show only the scopes this namespace's board draws")
    .action((opts) => scopeList(opts));

  scope
    .command("add <name>")
    .description("Add a cross-namespace card scope")
    .action((name) => scopeAdd(name));

  scope
    .command("delete <id>")
    .description("Delete a scope by ID or short ID")
    .action((id) => scopeDelete(id));

  scope
    .command("add-cards <scopeId> <cardIds...>")
    .description("Add cards to a scope")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the cards belong to")
    .action((scopeId, cardIds, opts) => scopeAddCards(scopeId, cardIds, opts));

  scope
    .command("remove-cards <scopeId> <cardIds...>")
    .description("Remove cards from a scope")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the cards belong to")
    .action((scopeId, cardIds, opts) => scopeRemoveCards(scopeId, cardIds, opts));

  const tag = program.command("tag").description("Tags written in cards and taskspace files");

  tag
    .command("list")
    .description("List every tag in a namespace, with what each one gathers")
    .option("--namespace <namespaceId>", "Namespace to read (default: the workspace default)")
    .action((opts) => tagList(opts));

  tag
    .command("show <tag>")
    .description("List the cards and files under a tag, subcategories included")
    .option("--namespace <namespaceId>", "Namespace to read (default: the workspace default)")
    .option("--no-files", "Skip taskspace files and list only cards")
    .action((name, opts) => tagShow(name, opts));

  const layer = program.command("layer").description("Layer management");

  layer
    .command("list")
    .description("List a namespace's layers, bottom to top")
    .option("--namespace <namespaceId>", "Namespace ID or short ID whose layers to list")
    .action((opts) => layerList(opts));

  layer
    .command("add <name>")
    .description("Add a layer on top of a namespace's existing layers")
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the layer to")
    .action((name, opts) => layerAdd(name, opts));

  layer
    .command("rename <layer> <name>")
    .description("Rename a layer by name, ID, or short ID — an exact name wins")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the layer belongs to")
    .action((id, name, opts) => layerRename(id, name, opts));

  layer
    .command("move <layer> <direction>")
    .description("Move a layer one step up or down the stack, by name, ID, or short ID")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the layer belongs to")
    .action((id, direction, opts) => layerMove(id, direction, opts));

  layer
    .command("delete <layer>")
    .description("Delete a layer by name, ID, or short ID, moving its cards to the default layer")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the layer belongs to")
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
    .description("List every taskspace in the workspace with its namespace and scope")
    .option("--namespace <namespaceId>", "Show only the taskspaces this namespace's board draws")
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
      "--namespace <namespaceId>",
      "Namespace ID or short ID (required when workspace has multiple namespaces)",
    )
    .option("--dir <path>", "Target directory (default: <workspaceRoot>/<name>)")
    .action((name, opts) => taskspaceCreate(name, opts));

  const card = program.command("card").description("Card management");

  card
    .command("add <content>")
    .description("Add a card to a namespace")
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the card to")
    .option("--partition <partitionId>", "Partition ID or short ID (defaults to General)")
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
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the cards to")
    .option("--partition <partitionId>", "Partition ID or short ID (defaults to General)")
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
    .option("--times", "Print created, updated, and gap above the text")
    .action((cardId, opts) => cardShow(cardId, opts));

  card
    .command("edit <cardId> <content>")
    .description("Replace a card's content")
    .action((cardId, content) => cardEdit(cardId, content));

  card
    .command("delete <cardIds...>")
    .description("Delete one or more cards from the same namespace")
    .action((cardIds) => cardDelete(cardIds));

  card
    .command("layer <cardId> <layer>")
    .description("Move a card to another layer of its namespace, by layer ID, short ID, or name")
    .action((cardId, layer) => cardSetLayer(cardId, layer));

  card
    .command("move <cardId>")
    .description("Move a card to an X/Y position")
    .option("--x <position>", "Horizontal integer or current+/-offset", cardPosition)
    .option("--y <position>", "Vertical integer or current+/-offset", cardPosition)
    .action((cardId, opts) => cardMove(cardId, opts));

  card
    .command("partition <partitionId> <cardIds...>")
    .description("Move cards to another partition in their namespace")
    .action((partitionId, cardIds) => cardSetPartition(partitionId, cardIds));

  card
    .command("namespace <namespaceId> <cardIds...>")
    .description("Move cards to another namespace, preserving partition and layer names")
    .action((namespaceId, cardIds) => cardSetNamespace(namespaceId, cardIds));

  card
    .command("glue <cardIds...>")
    .description("Glue two or more cards in the same namespace")
    .option("--add", "Keep and merge the cards' existing glue groups")
    .option("--align-list", "Align cards as a vertical list in argument order")
    .action((cardIds, opts) => cardGlue(cardIds, opts));

  card
    .command("unglue <cardIds...>")
    .description("Remove one or more cards from their glue groups")
    .action((cardIds) => cardUnglue(cardIds));

  card
    .command("nearest <cardId>")
    .description("List cards in the same namespace, nearest to the specified card first")
    .action((cardId) => cardNearest(cardId));

  const cardListCommand = card
    .command("list")
    .description("List cards in a namespace or taskspace scope")
    .option("--namespace <namespaceId>", "Namespace ID or short ID whose cards to list")
    .option("--partition <partitionId>", "Only list cards in this partition ID or short ID")
    .option("--taskspace <path>", "Taskspace directory or .taskspace.json path")
    .option(
      "--sort <key>",
      "Order by created, updated, or gap (the interval between the two)",
      cardSortKey,
    )
    .option("--reverse", "Reverse the --sort order")
    // `.catch(fail)`, because `cardList` refuses a malformed combination of these options
    // before it opens a workspace — outside the `runWorkspaceCommand` that reports every
    // other refusal. `program.parse()` does not await an action, so without this the rejection
    // would reach the user as an unhandled rejection and a stack trace.
    .action((opts) => cardList(opts).catch(fail));

  cardListCommand.addHelpText(
    "after",
    `
Taskspace behavior:
  If the current directory contains .taskspace.json, this command automatically
  lists cards for that taskspace when --namespace and --partition are omitted.

  Use --taskspace <path> from elsewhere. <path> may be either the taskspace
  directory or its .taskspace.json file. A scoped taskspace lists current
  scope members. A no-scope or deleted-scope taskspace lists cards associated
  directly with that taskspace and prints a status notice.

Sorting:
  --sort created  oldest card first
  --sort updated  least recently rewritten first
  --sort gap      shortest interval between the two first

  Only a change to a card's text counts as updating it. Moving a card across the
  board, resizing it, restacking it, or moving it to another partition or layer
  leaves both timestamps as they were, so --sort gap measures how long a card
  stood before it was rewritten rather than how recently it was rearranged.

  --sort adds the value it ordered by as a column, and --reverse flips the order.

Examples:
  kozane card list
  kozane card list --taskspace ./draft
  kozane card list --taskspace ./draft/.taskspace.json
  kozane card list --sort updated --reverse
  kozane card list --sort gap
`,
  );

  const warp = program.command("warp").description("Warp management");

  warp
    .command("list")
    .description("List a namespace's warps")
    .option("--namespace <namespaceId>", "Namespace ID or short ID whose warps to list")
    .action((opts) => warpList(opts));

  warp
    .command("add")
    .description("Add a warp at an X/Y position")
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the warp to")
    .requiredOption("--x <number>", "Horizontal warp position", integer)
    .requiredOption("--y <number>", "Vertical warp position", integer)
    .action((opts) => warpAdd(opts));

  warp
    .command("delete <warpId>")
    .description("Delete a warp by ID or short ID")
    .option("--namespace <namespaceId>", "Namespace ID or short ID the warp belongs to")
    .action((id, opts) => warpDelete(id, opts));

  return program;
}
