import type { TagsViewData } from "../../../../../src/services/tags.js";
import type { TagScanTruncation } from "../../../../../src/lib/types.js";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, fields: string[]) =>
  record(value) && fields.every((field) => typeof value[field] === "string");
const array = (value: unknown, check: (entry: unknown) => boolean) =>
  Array.isArray(value) && value.every(check);
const values = (value: unknown, check: (entry: unknown) => boolean) =>
  record(value) && Object.values(value).every(check);
const string = (value: unknown) => typeof value === "string";
const reasons: readonly TagScanTruncation[] = [
  "entries",
  "depth",
  "nodes",
  "unreadable",
  "budget",
  "hits",
  "too-large",
];
function hit(value: unknown): boolean {
  if (!record(value) || !strings(value, ["tag", "excerpt"]) || !record(value.source)) return false;
  const source = value.source;
  if (source.kind === "card") return strings(source, ["cardId"]);
  return (
    source.kind === "file" &&
    strings(source, ["taskspaceId", "path"]) &&
    typeof source.line === "number" &&
    Number.isSafeInteger(source.line) &&
    source.line > 0
  );
}
/** Reject incomplete gathers before replacing a tag view or its scan warnings. */
export function readTagsViewData(value: unknown): TagsViewData | null {
  if (!record(value) || !record(value.index)) return null;
  const index = value.index;
  if (
    !array(
      value.namespaces,
      (row) => record(row) && strings(row, ["id", "name"]) && typeof row.isDefault === "boolean",
    ) ||
    !array(value.cardPartitions, (row) =>
      strings(row, ["cardId", "partitionId", "partitionName"]),
    ) ||
    !values(value.partitions, (row) => strings(row, ["name", "dot"])) ||
    !array(index.hits, hit) ||
    !values(index.cardData, (row) => strings(row, ["namespaceId", "partitionId", "updatedDay"])) ||
    !values(index.cardNamespaces, string) ||
    !values(
      index.taskspaces,
      (row) =>
        record(row) && string(row.name) && (row.namespaceId === null || string(row.namespaceId)),
    ) ||
    !array(
      index.truncated,
      (row) =>
        record(row) &&
        string(row.taskspaceId) &&
        array(row.paths, string) &&
        array(row.reasons, (reason) => reasons.includes(reason as TagScanTruncation)),
    ) ||
    !array(index.missing, string) ||
    typeof index.cardsTruncated !== "boolean"
  )
    return null;
  return value as unknown as TagsViewData;
}
