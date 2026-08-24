import { count } from "drizzle-orm";
import { openingStatus } from "../lib/opening-status.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";
import {
  projectTable,
  bundleTable,
  cardTable,
  scopeTable,
  taskspaceTable,
} from "../../db/schema.js";

export async function status(): Promise<void> {
  // The one workspace command that runs against a database behind the current schema:
  // reporting the state of a workspace is exactly what is wanted when it needs attention.
  await runWorkspaceCommand(
    async ({ db, root, config }) => {
      const [[projects], [bundles], [cards], [scopes], [taskspaces]] = await Promise.all([
        db.select({ count: count() }).from(projectTable),
        db.select({ count: count() }).from(bundleTable),
        db.select({ count: count() }).from(cardTable),
        db.select({ count: count() }).from(scopeTable),
        db.select({ count: count() }).from(taskspaceTable),
      ]);

      console.log(`Workspace    : ${config.name}`);
      console.log(`Opening      : ${openingStatus(root)}`);
      console.log(`Projects     : ${projects.count}`);
      console.log(`Bundles      : ${bundles.count}`);
      console.log(`Cards        : ${cards.count}`);
      console.log(`Scopes       : ${scopes.count}`);
      console.log(`Taskspaces   : ${taskspaces.count}`);
    },
    { requireMigrations: false },
  );
}
