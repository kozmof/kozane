import { resolve } from "node:path";
import { count } from "drizzle-orm";
import { requireWorkspace } from "../lib/project.js";
import { dbUrl } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import {
  projectTable,
  bundleTable,
  cardTable,
  scopeTable,
  workingCopyTable,
} from "../../db/schema.js";

export async function status(): Promise<void> {
  const { root, config } = requireWorkspace();
  const db = openDb(dbUrl(resolve(root)));

  const [[projects], [bundles], [cards], [scopes], [workingCopies]] = await Promise.all([
    db.select({ count: count() }).from(projectTable),
    db.select({ count: count() }).from(bundleTable),
    db.select({ count: count() }).from(cardTable),
    db.select({ count: count() }).from(scopeTable),
    db.select({ count: count() }).from(workingCopyTable),
  ]);

  console.log(`Workspace    : ${config.name}`);
  console.log(`Projects     : ${projects.count}`);
  console.log(`Bundles      : ${bundles.count}`);
  console.log(`Cards        : ${cards.count}`);
  console.log(`Scopes       : ${scopes.count}`);
  console.log(`Working copies: ${workingCopies.count}`);
}
