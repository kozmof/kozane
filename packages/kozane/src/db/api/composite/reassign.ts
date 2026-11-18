import { records } from "@kozane/core/database";
export const deleteLayerWithReassignInTx: typeof records.compositeReassign.deleteLayerWithReassignInTx =
  records.compositeReassign.deleteLayerWithReassignInTx;
export const deletePartitionWithReassignInTx: typeof records.compositeReassign.deletePartitionWithReassignInTx =
  records.compositeReassign.deletePartitionWithReassignInTx;
export const deletePartitionWithReassign: typeof records.compositeReassign.deletePartitionWithReassign =
  records.compositeReassign.deletePartitionWithReassign;
export const deleteLayerWithReassign: typeof records.compositeReassign.deleteLayerWithReassign =
  records.compositeReassign.deleteLayerWithReassign;
