import { records } from "@kozane/core/database";
export const getAllLayers: typeof records.layer.getAllLayers = records.layer.getAllLayers;
export const getLayer: typeof records.layer.getLayer = records.layer.getLayer;
export const getDefaultLayer: typeof records.layer.getDefaultLayer = records.layer.getDefaultLayer;
export const addLayer: typeof records.layer.addLayer = records.layer.addLayer;
export const deleteLayerCascadingInTx: typeof records.layer.deleteLayerCascadingInTx =
  records.layer.deleteLayerCascadingInTx;
export const reorderLayers: typeof records.layer.reorderLayers = records.layer.reorderLayers;
export const reorderLayersInTx: typeof records.layer.reorderLayersInTx =
  records.layer.reorderLayersInTx;
export const updateLayerName: typeof records.layer.updateLayerName = records.layer.updateLayerName;
export type ReorderRejection = records.layer.ReorderRejection;
export type ReorderResult = records.layer.ReorderResult;
