import { createActionRegistryV2, type ActionHandlersV2 } from "./registry-v2.js";
import {
  actionContractsV2,
  type ActionInputsV2,
  type SyncableActionKindV2,
} from "./contracts-v2.js";
import { prepareActionInputForContracts } from "./invocation.js";
import {
  composeActionsForContract,
  type CompositionContext,
  type CompositionOptions,
  type CompositionReaders,
} from "./composition.js";

export function createCompositionRegistryV2<C>(
  handlers: Omit<ActionHandlersV2<CompositionContext<C>>, "system.compose">,
) {
  if (Object.hasOwn(handlers, "system.compose"))
    throw new TypeError("Composition owns the system.compose handler");
  return createActionRegistryV2<CompositionContext<C>>({
    ...handlers,
    "system.compose": {
      replay: async (input, execution) => {
        const { context } = execution;
        if (execution.bindings.mode === "record" && context.recordComposition)
          return context.recordComposition();
        for (const child of input.body.children)
          await context.actions.dispatch(child.path, child.kind, child.input, child.id);
      },
    },
  });
}
export function composeActionsV2<C, R extends CompositionReaders>(
  options: CompositionOptions<C, R, ActionInputsV2, SyncableActionKindV2>,
) {
  if (options.registry.contractVersion !== 2)
    return Promise.reject(new TypeError("Composition requires action contract 2"));
  return composeActionsForContract<C, R, ActionInputsV2, SyncableActionKindV2>(options, (input) =>
    prepareActionInputForContracts("system.compose", input, actionContractsV2),
  );
}
