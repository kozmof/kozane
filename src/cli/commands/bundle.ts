import { getAllBundles, addBundle } from "../../db/api/bundle.js";
import { deleteBundleWithReassign } from "../../db/api/composite.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

type BundleOptions = { project?: string };

export async function bundleList(options: BundleOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const projectId = await resolveProjectId(db, options.project);
    const bundles = await getAllBundles({ db, projectId });
    if (bundles.length === 0) {
      console.log("No bundles found.");
      return;
    }
    const ids = bundles.map(({ id }) => id);
    for (const bundle of bundles)
      console.log(
        `${shortId(bundle.id, ids)}  ${bundle.name}${bundle.isDefault ? "  (default)" : ""}`,
      );
  });
}

export async function bundleAdd(name: string, options: BundleOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Bundle name cannot be empty.");
    const projectId = await resolveProjectId(db, options.project);
    const id = await addBundle({ db, projectId, name: trimmed });
    const ids = (await getAllBundles({ db, projectId })).map((bundle) => bundle.id);
    console.log("Bundle added.");
    console.log(`  id  : ${shortId(id, ids)}`);
    console.log(`  name: ${trimmed}`);
  });
}

export async function bundleDelete(
  requestedId: string,
  options: BundleOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const projectId = await resolveProjectId(db, options.project);
    const bundles = await getAllBundles({ db, projectId });
    const ids = bundles.map(({ id }) => id);
    const bundleId = resolveShortId(requestedId, ids, "Bundle");
    await deleteBundleWithReassign({ db, projectId, bundleId });
    console.log("Bundle deleted.");
    console.log(`  id: ${shortId(bundleId, ids)}`);
    console.log("Cards in this bundle moved to the project's default bundle.");
  });
}
