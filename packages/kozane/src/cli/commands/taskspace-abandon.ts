import { abandonLocalOperation } from "../../lib/server/taskspace-service/abandon-operation.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export async function taskspaceAbandon(
  operationId: string,
  options: { reason: string; apply?: boolean },
) {
  await runWorkspaceCommand(async ({ db }) => {
    const result = await abandonLocalOperation(
      db,
      operationId,
      options.reason,
      options.apply === true,
    );
    console.log(`  operation : ${result.operation.id} (${result.operation.kind})`);
    console.log(`  taskspace : ${result.operation.taskspaceId}`);
    console.log(`  path      : ${result.operation.path} (${result.operation.pathKind})`);
    console.log(`  reason    : ${result.operation.abandonReason ?? options.reason.trim()}`);
    if (result.operation.error) console.log(`  error     : ${result.operation.error}`);
    console.log(`  intent    : ${result.operation.intent}`);
    if (result.changed)
      console.log(
        "Operation abandoned. Its evidence was retained. No files or attachments changed.",
      );
    else if (result.operation.state === "abandoned")
      console.log("Operation was already abandoned. No changes made.");
    else
      console.log(
        "Read-only preview. Finish reviewing disk state, then rerun with --apply to abandon tracking. This does not repair or cancel filesystem work.",
      );
  });
}
