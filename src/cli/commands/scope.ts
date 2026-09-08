import {
  addScope,
  deleteScope,
  getAllScopes,
  getScopeNamespaceUsage,
  getScopesInNamespace,
} from "../../db/api/scope.js";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { resolveNamespaceId } from "../lib/namespace-selection.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";
import { addScopeMembers, removeScopeMembersFromNamespace } from "../../db/api/scope-rel.js";
import { partitionTable, cardTable } from "../../db/schema.js";
import { eq } from "drizzle-orm";

export async function scopeAdd(name: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Scope name cannot be empty.");
    const scopeId = await addScope({ db, name: trimmedName });
    const scopeIds = (await getAllScopes({ db })).map((scope) => scope.id);
    console.log("Scope added.");
    console.log(`  id  : ${shortId(scopeId, scopeIds)}`);
    console.log(`  name: ${trimmedName}`);
  });
}

export type ScopeListOptions = { namespace?: string };

/**
 * Every scope in the workspace and the namespaces each one reaches.
 *
 * Workspace-wide on purpose: a board draws only its own namespace's scopes, so this is where
 * a scope shared with — or stranded in — another namespace is visible at all. `--namespace`
 * narrows it to exactly what that namespace's board would show.
 */
export async function scopeList(options: ScopeListOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    // Short IDs are always drawn against every scope in the workspace, so the ID printed
    // for a scope is the same one whether or not --namespace narrowed the list.
    const allScopes = await getAllScopes({ db });
    const scopeIds = allScopes.map((scope) => scope.id);

    const namespaceId = options.namespace ? await resolveNamespaceId(db, options.namespace) : null;
    const scopes = namespaceId ? await getScopesInNamespace({ db, namespaceId }) : allScopes;
    if (scopes.length === 0) {
      console.log(namespaceId ? "No scopes found in this namespace." : "No scopes found.");
      return;
    }

    const namespaces = await getAllNamespaces({ db });
    const namespaceNameById = new Map(
      namespaces.map((namespace) => [namespace.id, namespace.name]),
    );
    const usage = await getScopeNamespaceUsage({ db });
    const namespacesByScope = new Map<string, string[]>();
    for (const { scopeId, namespaceId: usedBy } of usage) {
      const names = namespacesByScope.get(scopeId) ?? [];
      names.push(namespaceNameById.get(usedBy) ?? usedBy);
      namespacesByScope.set(scopeId, names);
    }

    for (const scope of scopes) {
      // "(unused)" rather than a blank column: a scope no namespace has reached yet is
      // visible from every board, and that is worth saying rather than leaving to be read
      // as missing data.
      const where = namespacesByScope.get(scope.id)?.sort().join(", ") ?? "(unused)";
      console.log(`${shortId(scope.id, scopeIds)}  ${scope.name}  ${where}`);
    }
  });
}

export async function scopeDelete(scopeId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const scopes = await getAllScopes({ db });
    const scopeIds = scopes.map((scope) => scope.id);
    const resolvedId = resolveShortId(scopeId, scopeIds, "Scope");
    await deleteScope({ db, scopeId: resolvedId });
    console.log("Scope deleted.");
    console.log(`  id: ${shortId(resolvedId, scopeIds)}`);
    console.log("Taskspaces attached to this scope are now unscoped.");
  });
}

type ScopeMembersOptions = { namespace?: string };

async function changeScopeMembers(
  requestedScopeId: string,
  requestedCardIds: string[],
  options: ScopeMembersOptions,
  action: "add" | "remove",
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const scopes = await getAllScopes({ db });
    const scopeId = resolveShortId(
      requestedScopeId,
      scopes.map(({ id }) => id),
      "Scope",
    );
    const cards = await db
      .select({ id: cardTable.id, namespaceId: partitionTable.namespaceId })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id));
    const allCardIds = cards.map(({ id }) => id);
    const cardIds = requestedCardIds.map((id) => resolveShortId(id, allCardIds, "Card"));
    const result =
      action === "add"
        ? await addScopeMembers({ db, scopeId, namespaceId, cardIds })
        : await removeScopeMembersFromNamespace({ db, scopeId, namespaceId, cardIds });
    if (!result.ok)
      throw new Error(
        result.reason === "foreign-cards"
          ? "Cards must belong to the selected namespace."
          : "Scope not found.",
      );
    console.log(
      `${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} ${action === "add" ? "added to" : "removed from"} scope.`,
    );
    console.log(
      `  scope: ${shortId(
        scopeId,
        scopes.map(({ id }) => id),
      )}`,
    );
  });
}

export async function scopeAddCards(
  scopeId: string,
  cardIds: string[],
  options: ScopeMembersOptions = {},
): Promise<void> {
  await changeScopeMembers(scopeId, cardIds, options, "add");
}

export async function scopeRemoveCards(
  scopeId: string,
  cardIds: string[],
  options: ScopeMembersOptions = {},
): Promise<void> {
  await changeScopeMembers(scopeId, cardIds, options, "remove");
}
