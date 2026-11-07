import { records } from "@kozane/core/database";
export const getAllPartitions: typeof records.partition.getAllPartitions =
  records.partition.getAllPartitions;
export const getPartitionCardCounts: typeof records.partition.getPartitionCardCounts =
  records.partition.getPartitionCardCounts;
export const getPartition: typeof records.partition.getPartition = records.partition.getPartition;
export const addPartition: typeof records.partition.addPartition = records.partition.addPartition;
export const getDefaultPartition: typeof records.partition.getDefaultPartition =
  records.partition.getDefaultPartition;
export const deletePartitionCascadingInTx: typeof records.partition.deletePartitionCascadingInTx =
  records.partition.deletePartitionCascadingInTx;
export const updatePartitionName: typeof records.partition.updatePartitionName =
  records.partition.updatePartitionName;
export type PartitionCardCount = records.partition.PartitionCardCount;
