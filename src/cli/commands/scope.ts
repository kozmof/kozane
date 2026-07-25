import { resolve } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { commandDbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import { addScope, deleteScope, getAllScopes } from "../../db/api/scope.js";
import { resolveShortId, shortId } from "../lib/short-id.js";

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export async function scopeAdd(name: string): Promise<void> {
  try {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Scope name cannot be empty.");
    const { root } = requireWorkspace();
    const url = commandDbUrl(resolve(root));
    await runMigrations(url);
    const db = await createDb(url);
    const scopeId = await addScope({ db, name: trimmedName });
    const scopeIds = (await getAllScopes({ db })).map((scope) => scope.id);
    console.log("Scope added.");
    console.log(`  id  : ${shortId(scopeId, scopeIds)}`);
    console.log(`  name: ${trimmedName}`);
  } catch (error) {
    fail(error);
  }
}

export async function scopeList(): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const scopes = await getAllScopes({ db });
    if (scopes.length === 0) {
      console.log("No scopes found.");
      return;
    }
    const scopeIds = scopes.map((scope) => scope.id);
    for (const scope of scopes) {
      console.log(`${shortId(scope.id, scopeIds)}  ${scope.name}`);
    }
  } catch (error) {
    fail(error);
  }
}

export async function scopeDelete(scopeId: string): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const scopes = await getAllScopes({ db });
    const scopeIds = scopes.map((scope) => scope.id);
    const resolvedId = resolveShortId(scopeId, scopeIds, "Scope");
    await deleteScope({ db, scopeId: resolvedId });
    console.log("Scope deleted.");
    console.log(`  id: ${shortId(resolvedId, scopeIds)}`);
    console.log("Working copies attached to this scope are now unscoped.");
  } catch (error) {
    fail(error);
  }
}
