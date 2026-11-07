import { namespaces as service } from "@kozane/core/services";
export const create: typeof service.create = service.create;
export const list: typeof service.list = service.list;
export const get: typeof service.get = service.get;
export const remove: typeof service.remove = service.remove;
export const setDefault: typeof service.setDefault = service.setDefault;
export type NamespaceCreateInput = service.NamespaceCreateInput;
