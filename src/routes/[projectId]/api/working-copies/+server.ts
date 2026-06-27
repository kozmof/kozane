import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addWorkingCopy, deleteWorkingCopy } from "../../../../db/api/working-copy";
import { getCardsByScopeWithBundleName } from "../../../../db/api/scope-rel";
import { renderCardsMarkdown } from "../../../../lib/cards-template";
import { readJsonObject, requireTrimmedString } from "../../lib/request";
import { getWorkspaceRoot, getWorkingCopyDefaultDir } from "../../../../db/internal/config";
import { WC_MARKER_FILE, WC_MARKER_KIND, WC_MARKER_VERSION } from "../../../../lib/wc-marker";
import { NAME_MAX } from "$lib/constants";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");
  if (name.length > NAME_MAX) throw error(400, `name must be ${NAME_MAX} characters or fewer`);
  const scopeId = requireTrimmedString(body, "scopeId");

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  const defaultDir = getWorkingCopyDefaultDir(root);
  const targetDir = resolve(join(root, defaultDir, name));

  if (!targetDir.startsWith(resolve(root) + "/"))
    throw error(400, "Working copy path must be inside the workspace root");

  // The guard above ensures targetDir is always inside the workspace root,
  // so the path is always stored as project_relative. Absolute paths are
  // only produced by the CLI (kozane wc create --dir <outside-root>).
  const storedPath = relative(resolve(root), targetDir);

  const id = await addWorkingCopy({
    db,
    projectId: params.projectId,
    scopeId,
    name,
    path: storedPath,
    pathKind: "project_relative",
  });

  // Fetch cards before touching the filesystem so a DB error cannot leave
  // a phantom directory without a corresponding working-copy record.
  const cards = await getCardsByScopeWithBundleName({ db, scopeId });

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, WC_MARKER_FILE),
      JSON.stringify(
        {
          kind: WC_MARKER_KIND,
          version: WC_MARKER_VERSION,
          workingCopyId: id,
          projectId: params.projectId,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(targetDir, "cards.md"),
      renderCardsMarkdown({ name, scopeId, cards, projectRoot: root }),
    );
  } catch (e) {
    console.error("Failed to initialize working copy directory:", e);
    // Compensate: roll back the DB record and remove any partially-created directory.
    await deleteWorkingCopy({ db, workingCopyId: id });
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw error(500, "Failed to initialize working copy directory");
  }

  return json({ id, path: storedPath, pathKind: "project_relative" });
};
