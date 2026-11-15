import * as taskspaces from "../services/taskspaces.js";
import {
  actionContractsV2,
  type ActionInputsV2,
  type ActionKindV2,
  type SyncableActionKindV2,
} from "./contracts-v2.js";
import type { ActionHandlersV2 } from "./registry-v2.js";
import { createCompositionRegistryV2 } from "./composition-v2.js";
import * as cards from "../services/cards.js";
import * as glues from "../services/glues.js";
import * as layers from "../services/layers.js";
import * as partitions from "../services/partitions.js";
import * as scopes from "../services/scopes.js";
import * as warps from "../services/warps.js";
import * as inventories from "../services/inventories.js";
import * as namespaces from "../services/namespaces.js";
import type { ServiceContext } from "../services/context.js";
import {
  actionContractsV1,
  type ActionInputsV1,
  type ActionKindV1,
  type SyncableActionKindV1,
} from "./contracts.js";
import { createCompositionRegistryV1, type CompositionContext } from "./composition.js";
import type { ActionHandlersV1, ActionHandlerContext, defineActionRegistry } from "./registry.js";
import { runRequestedRepairInTx } from "./repair.js";
import { requireActionAllocations } from "./allocations.js";
import { withActionService } from "./service-frame.js";

export type ServiceActionContext<C extends ServiceContext = ServiceContext> = CompositionContext<C>;
export type LocalRecoveryHandlersV1<C extends ServiceContext = ServiceContext> = Pick<
  ActionHandlersV1<ServiceActionContext<C>>,
  Exclude<ActionKindV1, SyncableActionKindV1>
>;
type ServiceHandlers<C extends ServiceContext> = Pick<
  ActionHandlersV1<ServiceActionContext<C>>,
  Exclude<SyncableActionKindV1, "system.compose">
>;

function databaseHandlers<C extends ServiceContext>(): ServiceHandlers<C> {
  return {
    "system.repair": {
      replay: ({ body }, { context }) => runRequestedRepairInTx(context.db, context.value, body),
    },
    "cards.create": {
      replay: ({ args, body }, { context }) =>
        cards.createInTx(context.db, context.value, args.namespaceId, body),
    },
    "cards.update": {
      replay: ({ args, body }, { context }) =>
        cards.updateInTx(context.db, context.value, args.namespaceId, args.cardId, body),
    },
    "cards.updatePositions": {
      replay: ({ args, body }, { context }) =>
        cards.updatePositionsInTx(context.db, context.value, args.namespaceId, body),
    },
    "cards.remove": {
      replay: ({ args, body }, { context }) =>
        cards.removeInTx(context.db, context.value, args.namespaceId, body),
    },
    "cards.removeOne": {
      replay: ({ args }, { context }) =>
        cards.removeOneInTx(context.db, context.value, args.namespaceId, args.cardId),
    },
    "cards.move": {
      replay: ({ args, body }, { context }) =>
        cards.moveInTx(context.db, context.value, args.namespaceId, body),
    },
    "cards.setLayer": {
      replay: ({ args, body }, { context }) =>
        cards.setLayerInTx(context.db, context.value, args.namespaceId, body),
    },
    "cards.setPartition": {
      replay: ({ args, body }, { context }) =>
        cards.setPartitionInTx(context.db, context.value, args.namespaceId, body),
    },
    "cards.setStacking": {
      replay: ({ args, body }, { context }) =>
        cards.setStackingInTx(context.db, context.value, args.namespaceId, body),
    },
    "cards.squash": {
      replay: ({ args, body }, { context }) =>
        cards.squashInTx(context.db, context.value, args.namespaceId, body),
    },
    "glues.create": {
      replay: ({ args, body }, { context }) =>
        glues.createInTx(context.db, context.value, args.namespaceId, body),
    },
    "glues.remove": {
      replay: ({ args, body }, { context }) =>
        glues.removeInTx(context.db, context.value, args.namespaceId, body),
    },
    "layers.create": {
      replay: ({ args, body }, { context }) =>
        layers.createInTx(context.db, context.value, args.namespaceId, body),
    },
    "layers.rename": {
      replay: ({ args, body }, { context }) =>
        layers.renameInTx(context.db, context.value, args.namespaceId, args.layerId, body),
    },
    "layers.remove": {
      replay: ({ args }, { context }) =>
        layers.removeInTx(context.db, context.value, args.namespaceId, args.layerId),
    },
    "layers.reorder": {
      replay: ({ args, body }, { context }) =>
        layers.reorderInTx(context.db, context.value, args.namespaceId, body),
    },
    "partitions.create": {
      replay: ({ args, body }, { context }) =>
        partitions.createInTx(context.db, context.value, args.namespaceId, body),
    },
    "partitions.rename": {
      replay: ({ args, body }, { context }) =>
        partitions.renameInTx(context.db, context.value, args.namespaceId, args.partitionId, body),
    },
    "partitions.remove": {
      replay: ({ args }, { context }) =>
        partitions.removeInTx(context.db, context.value, args.namespaceId, args.partitionId),
    },
    "scopes.create": {
      replay: ({ body }, { context }) => scopes.createInTx(context.db, context.value, body),
    },
    "scopes.rename": {
      replay: ({ args, body }, { context }) =>
        scopes.renameInTx(context.db, context.value, args.namespaceId, args.scopeId, body),
    },
    "scopes.remove": {
      replay: ({ args }, { context }) =>
        scopes.removeInTx(context.db, context.value, args.namespaceId, args.scopeId),
    },
    "scopes.addMembers": {
      replay: ({ args, body }, { context }) =>
        scopes.addMembersInTx(context.db, context.value, args.namespaceId, args.scopeId, body),
    },
    "scopes.removeMembers": {
      replay: ({ args, body }, { context }) =>
        scopes.removeMembersInTx(context.db, context.value, args.namespaceId, args.scopeId, body),
    },
    "scopes.createArea": {
      replay: ({ args, body }, { context }) =>
        scopes.createAreaInTx(context.db, context.value, args.namespaceId, args.scopeId, body),
    },
    "scopes.updateArea": {
      replay: ({ args, body }, { context }) =>
        scopes.updateAreaInTx(
          context.db,
          context.value,
          args.namespaceId,
          args.scopeId,
          args.areaId,
          body,
        ),
    },
    "scopes.removeArea": {
      replay: ({ args }, { context }) =>
        scopes.removeAreaInTx(
          context.db,
          context.value,
          args.namespaceId,
          args.scopeId,
          args.areaId,
        ),
    },
    "scopes.removeWorkspace": {
      replay: ({ args }, { context }) =>
        scopes.removeWorkspaceInTx(context.db, context.value, args.scopeId),
    },
    "warps.create": {
      replay: ({ args, body }, { context }) =>
        warps.createInTx(context.db, context.value, args.namespaceId, body),
    },
    "warps.update": {
      replay: ({ args, body }, { context }) =>
        warps.updateInTx(context.db, context.value, args.namespaceId, args.warpId, body),
    },
    "warps.remove": {
      replay: ({ args }, { context }) =>
        warps.removeInTx(context.db, context.value, args.namespaceId, args.warpId),
    },
    "inventories.create": {
      replay: ({ args, body }, { context }) =>
        inventories.createInTx(context.db, context.value, args.namespaceId, body),
    },
    "inventories.update": {
      replay: ({ args, body }, { context }) =>
        inventories.updateInTx(context.db, context.value, args.namespaceId, args.inventoryId, body),
    },
    "inventories.remove": {
      replay: ({ args }, { context }) =>
        inventories.removeInTx(context.db, context.value, args.namespaceId, args.inventoryId),
    },
    "inventories.stow": {
      replay: ({ args, body }, { context }) =>
        inventories.stowInTx(context.db, context.value, args.namespaceId, args.inventoryId, body),
    },
    "inventories.take": {
      replay: ({ args, body }, { context }) =>
        inventories.takeInTx(context.db, context.value, args.namespaceId, body),
    },
    "namespaces.create": {
      replay: ({ body }, { context }) => namespaces.createInTx(context.db, context.value, body),
    },
    "namespaces.rename": {
      replay: ({ args, body }, { context }) =>
        namespaces.renameInTx(context.db, context.value, args.namespaceId, body),
    },
    "namespaces.remove": {
      replay: ({ args }, { context }) =>
        namespaces.removeInTx(context.db, context.value, args.namespaceId),
    },
    "namespaces.setDefault": {
      replay: ({ args }, { context }) =>
        namespaces.setDefaultInTx(context.db, context.value, args.namespaceId),
    },
  };
}

/** Internal opt-in registry for schemas 19 and 20. Hosts supply local recovery explicitly. */
export function createServiceActionRegistryV1<C extends ServiceContext = ServiceContext>(
  recoveryHandlers: LocalRecoveryHandlersV1<C>,
) {
  for (const kind of Object.keys(recoveryHandlers)) {
    if (
      !Object.hasOwn(actionContractsV1, kind) ||
      actionContractsV1[kind as ActionKindV1] !== "local-only"
    )
      throw new TypeError(`Unexpected local recovery handler: ${kind}`);
  }
  const registry = createCompositionRegistryV1<C>([19, 20], {
    ...recoveryHandlers,
    ...databaseHandlers<C>(),
  });
  return scopedServiceRegistry<C, ActionInputsV1>(registry);
}

function scopedServiceRegistry<C extends ServiceContext, Inputs extends object>(
  registry: ReturnType<typeof defineActionRegistry<Inputs, ServiceActionContext<C>>>,
) {
  const scoped = (
    execution: ActionHandlerContext<ServiceActionContext<C>>,
    operation: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      requireActionAllocations(execution.context.db, execution.bindings);
      return withActionService(execution.context.db, operation);
    } catch (cause) {
      const rejected = Promise.reject(cause);
      void rejected.catch(() => {});
      return rejected;
    }
  };
  return Object.freeze({
    ...registry,
    execute<K extends keyof Inputs & string>(
      kind: K,
      input: unknown,
      execution: ActionHandlerContext<ServiceActionContext<C>>,
    ) {
      return scoped(execution, () => registry.execute(kind, input, execution));
    },
    replay<K extends keyof Inputs & string>(
      kind: K,
      input: unknown,
      execution: ActionHandlerContext<ServiceActionContext<C>>,
    ) {
      return scoped(execution, () => registry.replay(kind, input, execution));
    },
  });
}

export type LocalRecoveryHandlersV2<C extends ServiceContext = ServiceContext> = Pick<
  ActionHandlersV2<ServiceActionContext<C>>,
  Exclude<ActionKindV2, SyncableActionKindV2>
>;
/** Version 2 taskspace lifecycle handlers read and change shared rows only. */
export function createServiceActionRegistryV2<C extends ServiceContext = ServiceContext>(
  recoveryHandlers: LocalRecoveryHandlersV2<C>,
) {
  for (const kind of Object.keys(recoveryHandlers)) {
    if (
      !Object.hasOwn(actionContractsV2, kind) ||
      actionContractsV2[kind as ActionKindV2] !== "local-only"
    )
      throw new TypeError("Unexpected local recovery handler: " + kind);
  }
  const registry = createCompositionRegistryV2<C>({
    ...recoveryHandlers,
    ...databaseHandlers<C>(),
    "taskspaces.create": {
      replay: ({ args, body }, { context }) =>
        taskspaces.createInTx(context.db, context.value, args.namespaceId, body),
    },
    "taskspaces.rename": {
      replay: ({ args, body }, { context }) =>
        taskspaces.renameInTx(context.db, context.value, args.namespaceId, args.taskspaceId, body),
    },
    "taskspaces.remove": {
      replay: ({ args }, { context }) =>
        taskspaces.removeInTx(context.db, context.value, args.namespaceId, args.taskspaceId),
    },
  });
  return scopedServiceRegistry<C, ActionInputsV2>(registry);
}
