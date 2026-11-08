import type { DatabaseFailure } from "../failures.js";

/** Libsql exposes SQLite codes directly or through a Drizzle cause wrapper. */
export function classifyLibsqlFailure(error: unknown): DatabaseFailure {
  const codes = new Set<string>();
  const seen = new Set<Error>();
  for (
    let current = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    for (const key of ["code", "extendedCode"] as const) {
      const code = (current as Error & { code?: unknown; extendedCode?: unknown })[key];
      if (typeof code === "string") codes.add(code);
    }
  }
  const has = (names: string[]) => names.some((name) => codes.has(name));
  return {
    kind: has(["SQLITE_CORRUPT", "SQLITE_NOTADB"])
      ? "database_content"
      : has(["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR", "SQLITE_CANTOPEN"])
        ? "transient"
        : "unknown",
    constraint: has(["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"])
      ? "unique"
      : has(["SQLITE_CONSTRAINT_FOREIGNKEY"])
        ? "foreign_key"
        : "other",
  };
}
