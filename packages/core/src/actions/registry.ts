import { prepareInput } from "../services/prepare-input.js";
import type { ActionBindings } from "./bindings.js";
import {
  ACTION_CONTRACT_VERSION,
  actionContractsV1,
  type ActionInputsV1,
  type ActionKindV1,
} from "./contracts.js";
import { prepareActionInputV1 } from "./invocation.js";

export class ActionContractRequiredError extends Error {
  override readonly name = "ActionContractRequiredError";
  readonly code = "action-contract-required";
  readonly supportedVersions: readonly number[];
  constructor(
    readonly requestedVersion: number,
    readonly schemaVersion: number,
    supportedVersions: readonly number[],
  ) {
    super(`Action contract ${requestedVersion} is not supported for schema ${schemaVersion}`);
    this.supportedVersions = Object.freeze([...supportedVersions]);
  }
}

export interface ActionHandlerContext<C> {
  readonly context: C;
  readonly bindings: ActionBindings;
}
export type ActionHandler<I, C> = (
  input: I,
  execution: ActionHandlerContext<C>,
) => Promise<unknown>;
export type ActionDefinition<I, C> = {
  readonly prepare: (input: unknown) => I;
} & (
  | { readonly eligibility: "syncable"; readonly replay: ActionHandler<I, C> }
  | { readonly eligibility: "local-only"; readonly recover: ActionHandler<I, C> }
);
export type ActionDefinitions<Inputs extends object, C> = {
  readonly [K in keyof Inputs]: ActionDefinition<Inputs[K], C>;
};
export type ActionHandlersV1<C> = {
  readonly [K in ActionKindV1]: (typeof actionContractsV1)[K] extends "syncable"
    ? { readonly replay: ActionHandler<ActionInputsV1[K], C> }
    : { readonly recover: ActionHandler<ActionInputsV1[K], C> };
};

/** Select once per root group and retain this registry for all descendants. */
export function defineActionRegistry<Inputs extends object, C>(options: {
  readonly contractVersion: number;
  readonly schemaVersions: readonly number[];
  readonly definitions: ActionDefinitions<Inputs, C>;
}) {
  const version = options.contractVersion;
  const schemas = new Set(options.schemaVersions);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    schemas.size === 0 ||
    [...schemas].some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new TypeError(
      "Action registries require a positive contract and supported schema versions",
    );
  // Copy descriptors so later caller mutation cannot change a registered contract.
  const definitions = new Map<string, ActionDefinition<unknown, C>>();
  for (const [kind, entry] of Object.entries(options.definitions) as [
    string,
    ActionDefinition<unknown, C>,
  ][]) {
    if (
      !kind ||
      typeof entry?.prepare !== "function" ||
      (entry.eligibility !== "syncable" && entry.eligibility !== "local-only")
    )
      throw new TypeError(`Invalid action definition: ${kind}`);
    const handler = entry.eligibility === "syncable" ? entry.replay : entry.recover;
    if (typeof handler !== "function") throw new TypeError(`Missing action handler: ${kind}`);
    definitions.set(kind, Object.freeze({ ...entry }));
  }
  return Object.freeze({
    contractVersion: version,
    supportsSchema: (schemaVersion: number) => schemas.has(schemaVersion),
    /** Only intent replay. File recovery is a separate, explicit operation. */
    async replay<K extends keyof Inputs & string>(
      kind: K,
      input: unknown,
      execution: ActionHandlerContext<C>,
    ): Promise<unknown> {
      const definition = definitions.get(kind);
      if (!definition) throw new TypeError(`Unknown action kind: ${kind}`);
      if (definition.eligibility !== "syncable")
        throw new TypeError(`Action is local-only: ${kind}`);
      if (execution.bindings.mode !== "replay")
        throw new TypeError("Intent replay requires recorded bindings");
      const prepared = definition.prepare(prepareInput(input));
      return definition.replay(prepared, execution);
    },
    async recover<K extends keyof Inputs & string>(
      kind: K,
      input: unknown,
      execution: ActionHandlerContext<C>,
    ): Promise<unknown> {
      const definition = definitions.get(kind);
      if (!definition) throw new TypeError(`Unknown action kind: ${kind}`);
      if (definition.eligibility !== "local-only")
        throw new TypeError(`Action has no file recovery handler: ${kind}`);
      const prepared = definition.prepare(prepareInput(input));
      return definition.recover(prepared, execution);
    },
  });
}

/** Require a handler of the declared kind for every version 1 envelope. */
export function createActionRegistryV1<C>(
  schemaVersions: readonly number[],
  handlers: ActionHandlersV1<C>,
) {
  const entries = Object.entries(actionContractsV1).map(([kind, eligibility]) => {
    if (!Object.hasOwn(handlers, kind)) throw new TypeError(`Missing action handler: ${kind}`);
    const handler = handlers[kind as ActionKindV1];
    return [
      kind,
      {
        ...handler,
        eligibility,
        prepare: (input: unknown) => prepareActionInputV1(kind as ActionKindV1, input),
      },
    ];
  });
  if (Object.keys(handlers).some((kind) => !Object.hasOwn(actionContractsV1, kind)))
    throw new TypeError("Unknown version 1 action handler");
  return defineActionRegistry<ActionInputsV1, C>({
    contractVersion: ACTION_CONTRACT_VERSION,
    schemaVersions,
    definitions: Object.fromEntries(entries) as ActionDefinitions<ActionInputsV1, C>,
  });
}

type RegistryCompatibility = {
  readonly contractVersion: number;
  supportsSchema(schemaVersion: number): boolean;
};

/** Compatibility selection performs no preparation, handler invocation or database writes. */
export function createActionRegistryCatalog<R extends RegistryCompatibility>(
  registries: readonly R[],
) {
  const versions = new Map<number, R>();
  for (const registry of registries) {
    if (versions.has(registry.contractVersion))
      throw new TypeError(`Duplicate action contract: ${registry.contractVersion}`);
    versions.set(registry.contractVersion, registry);
  }
  return Object.freeze({
    select(contractVersion: number, schemaVersion: number): R {
      const registry = versions.get(contractVersion);
      if (registry?.supportsSchema(schemaVersion)) return registry;
      const supported = [...versions.values()]
        .filter((entry) => entry.supportsSchema(schemaVersion))
        .map((entry) => entry.contractVersion)
        .sort((a, b) => a - b);
      throw new ActionContractRequiredError(contractVersion, schemaVersion, supported);
    },
  });
}
