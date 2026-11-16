import {
  ACTION_CONTRACT_VERSION_V2,
  actionContractsV2,
  type ActionInputsV2,
  type ActionKindV2,
} from "./contracts-v2.js";
import { defineActionRegistry, type ActionHandler, type ActionDefinitions } from "./registry.js";
import { prepareActionInputForContracts } from "./invocation.js";
export type ActionHandlersV2<C> = {
  readonly [K in ActionKindV2]: (typeof actionContractsV2)[K] extends "syncable"
    ? { readonly replay: ActionHandler<ActionInputsV2[K], C> }
    : { readonly recover: ActionHandler<ActionInputsV2[K], C> };
};
export function createActionRegistryV2<C>(handlers: ActionHandlersV2<C>) {
  const entries = Object.entries(actionContractsV2).map(([kind, eligibility]) => {
    if (!Object.hasOwn(handlers, kind)) throw new TypeError(`Missing action handler: ${kind}`);
    return [
      kind,
      {
        ...handlers[kind as ActionKindV2],
        eligibility,
        prepare: (input: unknown) =>
          prepareActionInputForContracts(kind as ActionKindV2, input, actionContractsV2),
      },
    ];
  });
  if (Object.keys(handlers).some((kind) => !Object.hasOwn(actionContractsV2, kind)))
    throw new TypeError("Unknown version 2 action handler");
  return defineActionRegistry<ActionInputsV2, C>({
    contractVersion: ACTION_CONTRACT_VERSION_V2,
    schemaVersions: [20, 21, 22, 23, 24, 25, 26],
    definitions: Object.fromEntries(entries) as ActionDefinitions<ActionInputsV2, C>,
  });
}
