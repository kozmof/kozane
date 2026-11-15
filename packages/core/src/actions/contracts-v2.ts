import { actionContractsV1, type ActionInputsV1, type ActionKindV1 } from "./contracts.js";

/** Version 1 remains pinned to host lifecycle recovery. Version 2 uses shared DB lifecycle intents. */
export const ACTION_CONTRACT_VERSION_V2 = 2;
export interface ActionInputsV2 extends Omit<ActionInputsV1, "system.compose"> {
  "system.compose": {
    args: Record<string, never>;
    body: { children: readonly CompositionChildV2[] };
  };
}
export type ActionKindV2 = ActionKindV1;
export const actionContractsV2 = Object.freeze({
  ...actionContractsV1,
  "taskspaces.create": "syncable",
  "taskspaces.rename": "syncable",
  "taskspaces.remove": "syncable",
} as const);
export type SyncableActionKindV2 = {
  [K in ActionKindV2]: (typeof actionContractsV2)[K] extends "syncable" ? K : never;
}[ActionKindV2];
export type CompositionChildV2 = {
  [K in SyncableActionKindV2]: {
    readonly id: string;
    readonly path: readonly string[];
    readonly kind: K;
    readonly input: ActionInputsV2[K];
  };
}[SyncableActionKindV2];
