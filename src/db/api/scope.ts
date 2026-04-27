import { scopeTable } from "../schema";
import { eq } from "drizzle-orm";
import type { NeedsDB, Scope } from "./types";
import { assertFound } from "./utils";

// Scopes are cross-project by design — they are not owned by any project or bundle
export async function getAllScopes({ db }: NeedsDB): Promise<Scope[]> {
  return db.select().from(scopeTable);
}

type GetScope = NeedsDB & { scopeId: string };
export async function getScope({ db, scopeId }: GetScope): Promise<Scope | undefined> {
  return db.select().from(scopeTable).where(eq(scopeTable.id, scopeId)).get();
}

export async function addScope({ db }: NeedsDB): Promise<string> {
  const [row] = await db.insert(scopeTable).values({}).returning({ id: scopeTable.id });
  return row.id;
}

type DeleteScope = NeedsDB & { scopeId: string };
export async function deleteScope({ db, scopeId }: DeleteScope): Promise<void> {
  const deleted = await db
    .delete(scopeTable)
    .where(eq(scopeTable.id, scopeId))
    .returning({ id: scopeTable.id });
  assertFound(deleted, `Scope scopeId=${scopeId}`);
}
