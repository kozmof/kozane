import { count } from "drizzle-orm";
import { openingStatus } from "../lib/opening-status.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";
import {
  namespaceTable,
  partitionTable,
  cardTable,
  scopeTable,
  taskspaceTable,
} from "../../db/schema.js";

export async function status(): Promise<void> {
  // The one workspace command that runs against a database behind the current schema:
  // reporting the state of a workspace is exactly what is wanted when it needs attention.
  await runWorkspaceCommand(
    async ({ db, root, config }) => {
      const [[namespaces], [partitions], [cards], [scopes], [taskspaces]] = await Promise.all([
        db.select({ count: count() }).from(namespaceTable),
        db.select({ count: count() }).from(partitionTable),
        db.select({ count: count() }).from(cardTable),
        db.select({ count: count() }).from(scopeTable),
        db.select({ count: count() }).from(taskspaceTable),
      ]);

      console.log(`Workspace    : ${config.name}`);
      console.log(`Opening      : ${openingStatus(root)}`);
      console.log(`Namespaces     : ${namespaces.count}`);
      console.log(`Partitions      : ${partitions.count}`);
      console.log(`Cards        : ${cards.count}`);
      console.log(`Scopes       : ${scopes.count}`);
      console.log(`Taskspaces   : ${taskspaces.count}`);
    },
    { requireMigrations: false },
  );
}
