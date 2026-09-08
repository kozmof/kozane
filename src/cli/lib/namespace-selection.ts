import type { DB } from "../../db/tx.js";
import { namespaceTable } from "../../db/schema.js";
import { resolveShortId } from "./short-id.js";

export async function resolveNamespaceId(db: DB, requestedId?: string): Promise<string> {
  const namespaces = await db
    .select({ id: namespaceTable.id, isDefault: namespaceTable.isDefault })
    .from(namespaceTable);
  if (requestedId) {
    return resolveShortId(
      requestedId,
      namespaces.map(({ id }) => id),
      "Namespace",
    );
  }
  if (namespaces.length === 0) {
    throw new Error('No namespaces found. Run "kozane namespace create <name>" first.');
  }
  const defaultNamespace = namespaces.find(({ isDefault }) => isDefault);
  if (defaultNamespace) return defaultNamespace.id;
  if (namespaces.length === 1) return namespaces[0].id;
  throw new Error(
    'Workspace has multiple namespaces but no default. Run "kozane namespace default <namespaceId>".',
  );
}
