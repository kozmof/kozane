/** Version 1 compares stable view data while ignoring new derived DTO fields. */
export async function summarizeView(view: {
  kind: string;
  namespaceId?: string;
  snapshot?: unknown;
}) {
  if (view.kind !== "selected") return { version: 1, kind: view.kind };
  const value = view.snapshot as {
    namespace: Record<string, unknown>;
    snapshot: Record<string, unknown>;
  };
  const pick = (row: unknown, fields: readonly string[]) =>
    Object.fromEntries(fields.map((field) => [field, (row as Record<string, unknown>)[field]]));
  const fields: Record<string, readonly string[]> = {
    cards: [
      "id",
      "partitionId",
      "layerId",
      "content",
      "posX",
      "posY",
      "zIndex",
      "width",
      "createdAt",
      "updatedAt",
      "glueId",
      "inventory",
    ],
    partitions: ["id", "namespaceId", "name", "isDefault"],
    layers: ["id", "namespaceId", "name", "position", "isDefault"],
    scopes: ["id", "name"],
    scopeRels: ["scopeId", "cardId"],
    glueRels: ["glueId", "cardId"],
  };
  const data: Record<string, unknown> = {
    namespace: pick(value.namespace, ["id", "name", "isDefault"]),
  };
  for (const [name, columns] of Object.entries(fields))
    data[name] = (value.snapshot[name] as unknown[]).map((row) => pick(row, columns));
  const normalize = (input: unknown): unknown => {
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input))
      return input.map(normalize).sort((a, b) => {
        const left = JSON.stringify(a),
          right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, normalize((input as Record<string, unknown>)[key])]),
      );
    return input;
  };
  const bytes = new TextEncoder().encode(JSON.stringify(normalize(data)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    version: 1,
    kind: view.kind,
    namespaceId: view.namespaceId,
    namespaceName: value.namespace.name,
    cardCount: (value.snapshot.cards as unknown[]).length,
    dataHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}
