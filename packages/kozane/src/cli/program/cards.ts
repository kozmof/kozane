/** `kozane card` and its subcommands. */
import { Command, Option } from "commander";

import {
  cardAdd,
  cardAddImage,
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
} from "../commands/card.js";
import { fail } from "../lib/workspace-command.js";
import { cardPosition, cardSortKey, integer } from "./parsers.js";

export function registerCardCommands(program: Command): void {
  const card = program.command("card").description("Card management");

  card
    .command("add <content>")
    .description("Add a text or image card to a namespace")
    .addOption(new Option("--type <type>", "Card type (image content is a local file path)").choices(["text", "image"]).default("text"))
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the card to")
    .option("--partition <partitionId>", "Partition ID or short ID (defaults to General)")
    .option("--scope <scopeId>", "Add the card to a scope ID or short ID")
    .option(
      "--layer <layer>",
      "Layer name, ID, or short ID, where an exact name wins (defaults to the default layer)",
    )
    .option("--x <number>", "Horizontal card position", integer)
    .option("--y <number>", "Vertical card position", integer)
    .action((content, opts) => opts.type === "image" ? cardAddImage(content, opts) : cardAdd(content, opts));

  card
    .command("squash [content]")
    .description(
      "Split an argument or stdin with a regex and add each part as a card in a new inventory",
    )
    .option("--namespace <namespaceId>", "Namespace ID or short ID to add the cards to")
    .option("--partition <partitionId>", "Partition ID or short ID (defaults to General)")
    .option("--scope <scopeId>", "Add the cards to a scope ID or short ID")
    .option(
      "--layer <layer>",
      "Layer name, ID, or short ID, where an exact name wins (defaults to the default layer)",
    )
    .option(
      "--pattern <regex>",
      "JavaScript regex used to split cards (default: period-space, 。, or blank line)",
    )
    .option("--x <number>", "Horizontal inventory position", integer)
    .option("--y <number>", "Vertical inventory position", integer)
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
    // Handle validation failures that occur before `runWorkspaceCommand`.
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
}
