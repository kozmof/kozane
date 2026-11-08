import * as namespaceService from "../../services/namespaces.js";
import { createServiceContext } from "../../services/context.js";
import { getUiConfigForRoot } from "../../db/internal/config.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export async function namespaceCreate(name: string): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const namespaceId = (
      await namespaceService.create(db, createServiceContext(getUiConfigForRoot(root)), { name })
    ).id;
    const namespaceIds = (
      await namespaceService.list(db, createServiceContext(getUiConfigForRoot(root)))
    ).map((namespace) => namespace.id);
    console.log(`Namespace created.`);
    console.log(`  id  : ${shortId(namespaceId, namespaceIds)}`);
    console.log(`  name: ${name}`);
  });
}

export async function namespaceList(): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const namespaces = await namespaceService.list(
      db,
      createServiceContext(getUiConfigForRoot(root)),
    );
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
  await runWorkspaceCommand(async ({ db, root }) => {
    const namespaces = await namespaceService.list(
      db,
      createServiceContext(getUiConfigForRoot(root)),
    );
    const namespaceIds = namespaces.map((namespace) => namespace.id);
    const resolvedId = resolveShortId(namespaceId, namespaceIds, "Namespace");
    await namespaceService.setDefault(
      db,
      createServiceContext(getUiConfigForRoot(root)),
      resolvedId,
    );
    console.log("Default namespace changed.");
    console.log(`  id  : ${shortId(resolvedId, namespaceIds)}`);
    console.log(`  name: ${namespaces.find((namespace) => namespace.id === resolvedId)?.name}`);
  });
}

export async function namespaceDelete(namespaceId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const namespaces = await namespaceService.list(
      db,
      createServiceContext(getUiConfigForRoot(root)),
    );
    const namespaceIds = namespaces.map((namespace) => namespace.id);
    const resolvedId = resolveShortId(namespaceId, namespaceIds, "Namespace");
    await namespaceService.remove(db, createServiceContext(getUiConfigForRoot(root)), resolvedId);
    console.log(`Namespace deleted.`);
    console.log(`  id: ${shortId(resolvedId, namespaceIds)}`);
  });
}
