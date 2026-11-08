/** Board structure commands: namespace, partition, scope, tag, and layer. */
import { Command } from "commander";

import {
  namespaceCreate,
  namespaceDefault,
  namespaceDelete,
  namespaceList,
} from "../commands/namespace.js";
import {
  scopeAdd,
  scopeAddCards,
  scopeDelete,
  scopeList,
  scopeRemoveCards,
} from "../commands/scope.js";
import { tagList, tagShow } from "../commands/tag.js";
import { layerAdd, layerDelete, layerList, layerMove, layerRename } from "../commands/layer.js";
import { partitionAdd, partitionDelete, partitionList } from "../commands/partition.js";

export function registerStructureCommands(program: Command): void {
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
    .description("Rename a layer by name, ID, or short ID, where an exact name wins")
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
}
