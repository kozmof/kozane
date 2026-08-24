import { createDb } from "../../db/client.js";
import type { DB } from "../../db/tx.js";
import { commandDbUrl, type WorkspaceConfig } from "./config.js";
import { requireCurrentMigrations } from "./db.js";
import { requireWorkspace } from "./project.js";

/**
 * Ends the command with a message rather than a stack trace. The one place the CLI turns
 * a thrown error into an exit code — it used to be copied verbatim into `card.ts`,
 * `layer.ts` and `scope.ts`, and written out inline again twice in `project.ts`.
 */
export function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** What a workspace command is handed once the workspace and its database are open. */
export type WorkspaceCommandContext = {
  db: DB;
  /**
   * The workspace root, already absolute — `findWorkspaceRoot` resolves before returning,
   * so the `resolve(root)` every one of these call sites used to do was a no-op.
   */
  root: string;
  config: WorkspaceConfig;
};

export type WorkspaceCommandOptions = {
  /**
   * Whether a database behind the current schema stops the command.
   *
   * On for everything that reads or writes rows, which is the point: a workspace left
   * behind by an upgrade now refuses the same way from every command instead of three
   * different ways (see {@link requireCurrentMigrations}).
   *
   * Off for `kozane status`, whose whole job is to report the workspace as it is. Refusing
   * to describe a workspace because it needs attention is the one case where the guard
   * would withhold exactly the information being asked for.
   */
  requireMigrations?: boolean;
};

/**
 * The shape every workspace command shares: find the workspace, check the schema, open the
 * session database, and turn anything thrown into a one-line error and a non-zero exit.
 *
 * The database is always {@link commandDbUrl}, which is the fix this exists to make
 * permanent. That resolver points at the temporary database of a running `kozane open
 * --memory` server, and `card`, `layer`, `scope`, `taskspace` and `status` used it while
 * `project` did not — so with a memory server up, `kozane card add` wrote to the session
 * while `kozane project list` read the disk, and `kozane project create` made a project
 * the open board could never show. `spec/cli.md` says project-dependent commands use the
 * session database; now they cannot do otherwise.
 *
 * Not for `db`, `doctor` or `net ssg`: those deliberately target the on-disk database even
 * while a memory server runs, and say so where they open it.
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
    return await run({ db, root, config });
  } catch (error) {
    fail(error);
  }
}
