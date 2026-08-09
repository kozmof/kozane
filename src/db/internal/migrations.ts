import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Absolute path to the bundled `drizzle/` migrations folder.
 *
 * Resolved from this module rather than from `process.cwd()` so migrations are
 * found no matter which directory a command runs in, under both tsx and the
 * compiled output.
 */
export function resolveMigrationsFolder(): string {
  // src/db/internal -> src/db -> src -> package root
  // (dist/db/internal -> dist/db -> dist -> package root)
  const here = dirname(fileURLToPath(import.meta.url));
  return join(resolve(here, "../../.."), "drizzle");
}
