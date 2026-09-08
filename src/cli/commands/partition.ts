import { getAllPartitions, addPartition } from "../../db/api/partition.js";
import { deletePartitionWithReassign } from "../../db/api/composite.js";
import { resolveNamespaceId } from "../lib/namespace-selection.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

type PartitionOptions = { namespace?: string };

export async function partitionList(options: PartitionOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const partitions = await getAllPartitions({ db, namespaceId });
    if (partitions.length === 0) {
      console.log("No partitions found.");
      return;
    }
    const ids = partitions.map(({ id }) => id);
    for (const partition of partitions)
      console.log(
        `${shortId(partition.id, ids)}  ${partition.name}${partition.isDefault ? "  (default)" : ""}`,
      );
  });
}

export async function partitionAdd(name: string, options: PartitionOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Partition name cannot be empty.");
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const id = await addPartition({ db, namespaceId, name: trimmed });
    const ids = (await getAllPartitions({ db, namespaceId })).map((partition) => partition.id);
    console.log("Partition added.");
    console.log(`  id  : ${shortId(id, ids)}`);
    console.log(`  name: ${trimmed}`);
  });
}

export async function partitionDelete(
  requestedId: string,
  options: PartitionOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const partitions = await getAllPartitions({ db, namespaceId });
    const ids = partitions.map(({ id }) => id);
    const partitionId = resolveShortId(requestedId, ids, "Partition");
    await deletePartitionWithReassign({ db, namespaceId, partitionId });
    console.log("Partition deleted.");
    console.log(`  id: ${shortId(partitionId, ids)}`);
    console.log("Cards in this partition moved to the namespace's default partition.");
  });
}
