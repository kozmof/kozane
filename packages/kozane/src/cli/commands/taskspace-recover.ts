import { recoverTaskspaceOperation } from "../../lib/server/taskspace-service/recover-operation.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

/** Inspect by default. Applying finishes verified database changes without changing disk. */
export async function taskspaceRecover(operationId: string, options: { apply?: boolean } = {}) {
  await runWorkspaceCommand(async ({ db, root }) => {
    const result = await recoverTaskspaceOperation(db, root, operationId, options.apply === true);
    const claim = result.operation.kind === "taskspace.claim";
    console.log(`  operation : ${result.operation.id} (${result.operation.kind})`);
    console.log(`  taskspace : ${result.operation.taskspaceId}`);
    console.log(`  path      : ${result.operation.path} (${result.operation.pathKind})`);
    if (result.intent) {
      console.log(`  action    : ${result.intent.operation}`);
      if ("targetPath" in result.intent) console.log(`  target    : ${result.intent.targetPath}`);
      if ("name" in result.intent) console.log(`  label     : ${result.intent.name}`);
    }
    if (result.status === "blocked")
      throw new Error(`Directory operation cannot be confirmed: ${result.reason}`);
    if (result.status === "confirmable")
      console.log(
        claim
          ? "Directory verified. Rerun with --apply to confirm its attachment."
          : "Directory state verified. Rerun with --apply to finish its database changes.",
      );
    else if (result.status === "already-confirmed")
      console.log("Directory operation was already confirmed. No changes made.");
    else
      console.log(
        claim
          ? "Directory attachment confirmed. No files changed."
          : "Directory database changes confirmed. No files changed.",
      );
  });
}
