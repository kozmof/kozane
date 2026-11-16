import { recoverLocalClaim } from "../../lib/server/taskspace-service/recover-claim.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

/** Inspect by default. Applying confirms database attachment without changing disk. */
export async function taskspaceRecover(operationId: string, options: { apply?: boolean } = {}) {
  await runWorkspaceCommand(async ({ db, root }) => {
    const result = await recoverLocalClaim(db, root, operationId, options.apply === true);
    console.log(`  claim     : ${result.operation.id}`);
    console.log(`  taskspace : ${result.operation.taskspaceId}`);
    console.log(`  path      : ${result.operation.path} (${result.operation.pathKind})`);
    if (result.status === "blocked")
      throw new Error(`Directory claim cannot be confirmed: ${result.reason}`);
    if (result.status === "confirmable")
      console.log("Directory verified. Rerun with --apply to confirm its attachment.");
    else if (result.status === "already-confirmed")
      console.log("Directory claim was already confirmed. No changes made.");
    else console.log("Directory attachment confirmed. No files changed.");
  });
}
