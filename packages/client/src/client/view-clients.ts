import type { KozaneClient, ClientCapabilities } from "./contract.js";
/** Shared observation surface. Borrowed views cannot dispose their host's connection. */
export type ClientStatus = Pick<KozaneClient, "state" | "subscribeState">;
export type ClientEvents = ClientStatus & Pick<KozaneClient, "version" | "subscribe">;
type ViewCapabilities = { readonly capabilities: Pick<ClientCapabilities, "writable"> };
export type TagsViewClient = ClientEvents &
  ViewCapabilities & { readonly tags: Pick<KozaneClient["tags"], "get"> };
export type MapViewClient = ClientEvents &
  ViewCapabilities & { readonly map: Pick<KozaneClient["map"], "get"> };
export type NamespacesViewClient = ClientEvents &
  ViewCapabilities & { readonly namespaces: Pick<KozaneClient["namespaces"], "list" | "create"> };
export type BoardViewClient = Pick<
  KozaneClient,
  | "capabilities"
  | "version"
  | "state"
  | "subscribe"
  | "subscribeState"
  | "snapshot"
  | "cards"
  | "glues"
  | "layers"
  | "partitions"
  | "scopes"
  | "warps"
  | "inventories"
  | "warpDirectory"
  | "taskspaces"
>;
