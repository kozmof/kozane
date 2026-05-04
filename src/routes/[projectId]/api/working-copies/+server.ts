import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { addWorkingCopy } from "../../../../db/api/working-copy";
import { readJsonObject, requireTrimmedString } from "../../lib/request";
import { getWorkspaceRoot } from "../../../../db/internal/config";
import { readConfig } from "../../../../cli/lib/config";
import { WC_MARKER_DIR, WC_MARKER_FILE } from "../../../../cli/lib/wc-scan";

const WC_MARKER_KIND = "kozane.workingCopy";
const WC_MARKER_VERSION = 1;

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");
  const scopeId = requireTrimmedString(body, "scopeId");

  const root = getWorkspaceRoot();
  if (!root) throw new Error("No workspace root found");

  const config = readConfig(root);
  const targetDir = resolve(join(root, config.workingCopy.defaultDir, name));

  const pathKind = targetDir.startsWith(resolve(root))
    ? ("project_relative" as const)
    : ("absolute" as const);
  const storedPath = pathKind === "project_relative" ? relative(resolve(root), targetDir) : targetDir;

  const id = await addWorkingCopy({
    db,
    projectId: params.projectId,
    scopeId,
    name,
    path: storedPath,
    pathKind,
  });

  mkdirSync(join(targetDir, WC_MARKER_DIR), { recursive: true });
  writeFileSync(
    join(targetDir, WC_MARKER_DIR, WC_MARKER_FILE),
    JSON.stringify({ kind: WC_MARKER_KIND, version: WC_MARKER_VERSION, workingCopyId: id, projectId: params.projectId }, null, 2) + "\n",
  );

  return json({ id });
};
