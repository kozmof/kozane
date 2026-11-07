import type { TreemapSnapshot } from "../../../../../src/services/map.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown, fields: string[]): boolean =>
  isRecord(value) && fields.every((field) => typeof value[field] === "string");
const arrayOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);

const isNamespace = (value: unknown): boolean =>
  strings(value, ["id", "name"]) &&
  typeof (value as Record<string, unknown>).isDefault === "boolean";
const isPartition = (value: unknown): boolean =>
  strings(value, ["id", "namespaceId", "name", "bg", "dot"]) &&
  typeof (value as Record<string, unknown>).isDefault === "boolean" &&
  Number.isFinite((value as Record<string, unknown>).cards);
const isActivity = (value: unknown): boolean =>
  strings(value, ["day", "partitionId"]) &&
  Number.isFinite((value as Record<string, unknown>).cards);
const isScope = (value: unknown): boolean => strings(value, ["id", "name"]);
const isPartitionUsage = (value: unknown): boolean =>
  strings(value, ["scopeId", "partitionId"]) &&
  Number.isFinite((value as Record<string, unknown>).cards);
const isNamespaceUsage = (value: unknown): boolean => strings(value, ["scopeId", "namespaceId"]);
const isTagHit = (value: unknown): boolean => {
  if (!strings(value, ["tag", "excerpt"])) return false;
  const source = (value as Record<string, unknown>).source;
  return isRecord(source) && source.kind === "card" && typeof source.cardId === "string";
};
const isTags = (value: unknown): boolean => {
  if (!isRecord(value) || !arrayOf(value.hits, isTagHit) || typeof value.truncated !== "boolean")
    return false;
  if (
    !isRecord(value.cardNamespaces) ||
    !Object.values(value.cardNamespaces).every((v) => typeof v === "string")
  )
    return false;
  return (
    isRecord(value.cardData) &&
    Object.values(value.cardData).every((card) =>
      strings(card, ["namespaceId", "partitionId", "updatedDay"]),
    )
  );
};

export function readMapSnapshot(value: unknown): TreemapSnapshot | null {
  if (!isRecord(value)) return null;
  const snapshot = value;
  return arrayOf(snapshot.namespaces, isNamespace) &&
    arrayOf(snapshot.partitions, isPartition) &&
    arrayOf(snapshot.activity, isActivity) &&
    arrayOf(snapshot.scopes, isScope) &&
    arrayOf(snapshot.partitionUsage, isPartitionUsage) &&
    arrayOf(snapshot.namespaceUsage, isNamespaceUsage) &&
    isTags(snapshot.tags)
    ? (snapshot as unknown as TreemapSnapshot)
    : null;
}
