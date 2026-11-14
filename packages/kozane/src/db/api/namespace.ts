import { records } from "@kozane/core/database";
export const getAllNamespaces: typeof records.namespace.getAllNamespaces =
  records.namespace.getAllNamespaces;
export const getNamespace: typeof records.namespace.getNamespace = records.namespace.getNamespace;
export const addNamespace: typeof records.namespace.addNamespace = records.namespace.addNamespace;
export const createNamespace: typeof records.namespace.createNamespace =
  records.namespace.createNamespace;
export const setDefaultNamespace: typeof records.namespace.setDefaultNamespace =
  records.namespace.setDefaultNamespace;
export const deleteNamespace: typeof records.namespace.deleteNamespace =
  records.namespace.deleteNamespace;
export const updateNamespaceName: typeof records.namespace.updateNamespaceName =
  records.namespace.updateNamespaceName;

export const deleteNamespaceInTx = records.namespace.deleteNamespaceInTx;
