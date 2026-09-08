import {
  createNamespace,
  deleteNamespace,
  getAllNamespaces,
  setDefaultNamespace,
} from "../../db/api/namespace.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export async function namespaceCreate(name: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await createNamespace({ db, name });
    const namespaceIds = (await getAllNamespaces({ db })).map((namespace) => namespace.id);
    console.log(`Namespace created.`);
    console.log(`  id  : ${shortId(namespaceId, namespaceIds)}`);
    console.log(`  name: ${name}`);
  });
}

export async function namespaceList(): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaces = await getAllNamespaces({ db });
    if (namespaces.length === 0) {
      console.log("No namespaces found.");
      return;
    }
    const namespaceIds = namespaces.map((namespace) => namespace.id);
    for (const namespace of namespaces) {
      console.log(
        `${shortId(namespace.id, namespaceIds)}  ${namespace.name}${namespace.isDefault ? "  (default)" : ""}`,
      );
    }
  });
}

export async function namespaceDefault(namespaceId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaces = await getAllNamespaces({ db });
    const namespaceIds = namespaces.map((namespace) => namespace.id);
    const resolvedId = resolveShortId(namespaceId, namespaceIds, "Namespace");
    await setDefaultNamespace({ db, namespaceId: resolvedId });
    console.log("Default namespace changed.");
    console.log(`  id  : ${shortId(resolvedId, namespaceIds)}`);
    console.log(`  name: ${namespaces.find((namespace) => namespace.id === resolvedId)?.name}`);
  });
}

export async function namespaceDelete(namespaceId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaces = await getAllNamespaces({ db });
    const namespaceIds = namespaces.map((namespace) => namespace.id);
    const resolvedId = resolveShortId(namespaceId, namespaceIds, "Namespace");
    await deleteNamespace({ db, namespaceId: resolvedId });
    console.log(`Namespace deleted.`);
    console.log(`  id: ${shortId(resolvedId, namespaceIds)}`);
  });
}
