/** Report recovery evidence once per served database and workspace, without changing it. */
import type { DB } from "../../db/database.js";
import { pendingLocalClaims } from "./local-file-operations.js";

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
      })
      .catch(() => {
        warn("[kozane] Could not inspect local directory claims. Run 'kozane doctor'.");
      });
    roots.set(root, inspection);
    return inspection;
  };
}

export const reportPendingLocalClaims = createLocalClaimStartupCheck();
