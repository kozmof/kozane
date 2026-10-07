import { createDb } from "../../db/client.js";
import type { DB } from "../../db/tx.js";
import { commandDbUrl, type WorkspaceConfig } from "./config.js";
import { requireCurrentMigrations } from "./db.js";
import { requireWorkspace } from "./workspace.js";

/** Report a CLI error as a message and nonzero exit status. */
export function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** What a workspace command is handed once the workspace and its database are open. */
export type WorkspaceCommandContext = {
  db: DB;
  /** Absolute workspace root returned by `findWorkspaceRoot`. */
  root: string;
  config: WorkspaceConfig;
  /**
   * Database URL resolved by {@link commandDbUrl}. This points to the running memory session
   * when present, or the workspace database otherwise. Reuse it when identifying this
   * connection.
   */
  dbUrl: string;
};

export type WorkspaceCommandOptions = {
  /** Require current migrations for workspace commands, except status. */
  requireMigrations?: boolean;
};

/**
 * Find the workspace, require current migrations, open the session database, and report
 * errors through the CLI error handler.
 *
 * Use {@link commandDbUrl} so workspace commands share the database served by `kozane open
 * --memory`. Database maintenance, diagnostics, and static export deliberately open the
 * on-disk database separately.
 */
export async function runWorkspaceCommand<T>(
  run: (context: WorkspaceCommandContext) => Promise<T>,
  { requireMigrations = true }: WorkspaceCommandOptions = {},
): Promise<T> {
  try {
    const { root, config } = requireWorkspace();
    const url = commandDbUrl(root);
    if (requireMigrations) await requireCurrentMigrations(url, "this command can run");
    const db = await createDb(url);
    return await run({ db, root, config, dbUrl: url });
  } catch (error) {
    fail(error);
  }
}
