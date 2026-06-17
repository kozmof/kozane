import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addWorkingCopy, deleteWorkingCopy } from "../../../../db/api/working-copy";
import { addProjectScopeRel } from "../../../../db/api/scope";
import { withTx } from "../../../../db/tx";
import { getCardsByScopeWithBundleName } from "../../../../db/api/scope-rel";
import { renderCardsMarkdown } from "../../../../lib/cards-template";
import { readJsonObject, requireTrimmedString } from "../../lib/request";
import { getWorkspaceRoot, getWorkingCopyDefaultDir } from "../../../../db/internal/config";
import { WC_MARKER_FILE, WC_MARKER_KIND, WC_MARKER_VERSION } from "../../../../lib/wc-marker";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");
  const scopeId = requireTrimmedString(body, "scopeId");

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  const defaultDir = getWorkingCopyDefaultDir(root);
  const targetDir = resolve(join(root, defaultDir, name));

  if (!targetDir.startsWith(resolve(root) + "/") && targetDir !== resolve(root))
    throw error(400, "Working copy path must be inside the workspace root");

  const pathKind = targetDir.startsWith(resolve(root))
    ? ("project_relative" as const)
    : ("absolute" as const);
  const storedPath =
    pathKind === "project_relative" ? relative(resolve(root), targetDir) : targetDir;

  const id = await withTx(db, async (tx) => {
    const wcId = await addWorkingCopy({
      db: tx,
      projectId: params.projectId,
      scopeId,
      name,
      path: storedPath,
      pathKind,
    });
    await addProjectScopeRel({ db: tx, projectId: params.projectId, scopeId });
    return wcId;
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
  } catch {
    // Compensate: roll back the DB record so the UI doesn't show a broken entry.
    await deleteWorkingCopy({ db, workingCopyId: id });
    throw error(500, "Failed to initialize working copy directory");
  }

  return json({ id, path: storedPath, pathKind });
};
