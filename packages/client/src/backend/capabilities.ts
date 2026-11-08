import type { ClientCapabilities, KozaneClient } from "./contract.js";
import type { TaskspacesApi } from "./taskspaces-api.js";

const methods = {
  access: true,
  create: true,
  rename: true,
  remove: true,
  createFile: true,
  readFile: true,
  saveFile: true,
  list: true,
  createDirectory: true,
  renameEntry: true,
  removeEntry: true,
} satisfies Record<keyof TaskspacesApi, true>;

export type ClientFeatures = Readonly<{
  capabilities: ClientCapabilities;
  taskspaces: TaskspacesApi | undefined;
}>;

function checkApi(api: TaskspacesApi) {
  for (const method of Object.keys(methods) as (keyof TaskspacesApi)[])
    if (typeof api?.[method] !== "function")
      throw new TypeError(`Taskspace API requires ${method}`);
}

/** Derive taskspace availability from the attached API and freeze the feature pair. */
export function createClientFeatures(
  capabilities: Omit<ClientCapabilities, "taskspaces">,
  taskspaces?: TaskspacesApi,
): ClientFeatures {
  if (taskspaces !== undefined) checkApi(taskspaces);
  return Object.freeze({
    capabilities: Object.freeze({ ...capabilities, taskspaces: taskspaces !== undefined }),
    taskspaces,
  });
}

export function assertTaskspaceSupport(client: Pick<KozaneClient, "capabilities" | "taskspaces">) {
  if (client.capabilities.taskspaces !== (client.taskspaces !== undefined))
    throw new TypeError("Taskspace capability/API mismatch");
  if (client.taskspaces !== undefined) checkApi(client.taskspaces);
}
