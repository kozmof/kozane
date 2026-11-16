/** Report recovery evidence once per served database and workspace, without changing it. */
import type { DB } from "../../db/database.js";
import { pendingLocalClaims } from "./local-file-operations.js";
import { pendingTaskspaceFileOperations } from "./taskspace-file-operations.js";
import { pendingTaskspaceDirectoryOperations } from "./taskspace-directory-operations.js";

export function createLocalClaimStartupCheck(
  warn: (message: string) => void = (message) => console.warn(message),
) {
  const checked = new WeakMap<DB, Map<string, Promise<void>>>();
  return (db: DB, root: string): Promise<void> => {
    let roots = checked.get(db);
    if (!roots) {
      roots = new Map();
      checked.set(db, roots);
    }
    const previous = roots.get(root);
    if (previous) return previous;
    const inspection = Promise.resolve()
      .then(async () => {
        const pending = await pendingLocalClaims(db, root);
        if (pending.total > 0)
          warn(
            `[kozane] ${pending.total} pending directory claim(s): ${pending.named.map(({ id, observation }) => `${id} (${observation})`).join(", ")}. Run 'kozane doctor' and 'kozane taskspace recover <operationId>' to inspect them.`,
          );
        const files = await pendingTaskspaceFileOperations(db, root);
        if (files.total > 0)
          warn(
            `[kozane] ${files.total} pending taskspace file operation(s): ${files.named.map(({ id, observation }) => `${id} (${observation})`).join(", ")}. Run 'kozane doctor' before repeating them. Filesystem work was not retried.`,
          );
        const directories = await pendingTaskspaceDirectoryOperations(db, root);
        if (directories.total > 0)
          warn(
            `[kozane] ${directories.total} pending taskspace directory operation(s): ${directories.named.map(({ id, observation }) => `${id} (${observation})`).join(", ")}. Run 'kozane doctor' and 'kozane taskspace recover <operationId>' to inspect them. Directory work was not retried.`,
          );
      })
      .catch(() => {
        warn("[kozane] Could not inspect local filesystem operations. Run 'kozane doctor'.");
      });
    roots.set(root, inspection);
    return inspection;
  };
}

export const reportPendingLocalClaims = createLocalClaimStartupCheck();
