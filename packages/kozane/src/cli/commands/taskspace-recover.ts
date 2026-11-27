import { recoverTaskspaceOperation } from "../../lib/server/taskspace-service/recover-operation.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

/** Inspect by default. Applying finishes verified database changes without changing disk. */
export async function taskspaceRecover(operationId: string, options: { apply?: boolean } = {}) {
  await runWorkspaceCommand(async ({ db, root }) => {
    const result = await recoverTaskspaceOperation(db, root, operationId, options.apply === true);
    const claim = result.operation.kind === "taskspace.claim";
    const file = result.operation.kind === "taskspace.file";
    console.log(`  operation : ${result.operation.id} (${result.operation.kind})`);
    console.log(`  taskspace : ${result.operation.taskspaceId}`);
    console.log(`  path      : ${result.operation.path} (${result.operation.pathKind})`);
    if (result.intent) {
      console.log(`  action    : ${result.intent.operation}`);
      if ("targetPath" in result.intent) console.log(`  target    : ${result.intent.targetPath}`);
      if ("name" in result.intent)
        console.log(`  ${file ? "name      " : "label     "}: ${result.intent.name}`);
      if ("contentHash" in result.intent) console.log(`  sha256    : ${result.intent.contentHash}`);
    }
    if (result.status === "blocked")
      throw new Error(
        `${file ? "File" : "Directory"} operation cannot be confirmed: ${result.reason}`,
      );
    if (result.status === "confirmable")
      console.log(
        claim
          ? "Directory verified. Rerun with --apply to confirm its attachment."
          : file
            ? "File outcome matches recorded intent. Review disk state, then rerun with --apply to confirm tracking."
            : "Directory state verified. Rerun with --apply to finish its database changes.",
      );
    else if (result.status === "already-confirmed")
      console.log(
        `${file ? "File" : "Directory"} operation was already confirmed. No changes made.`,
      );
    else
      console.log(
        claim
          ? "Directory attachment confirmed. No files changed."
          : file
            ? "File operation tracking confirmed. No files changed."
            : "Directory database changes confirmed. No files changed.",
      );
  });
}
