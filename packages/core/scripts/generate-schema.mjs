import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { format } from "oxfmt";
// These build inputs contain only type imports. Transpilation leaves the exact portable reader
// and generated migration records, without loading a driver into the public runtime entries.
async function portableModule(relative) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputText).toString("base64")}`);
}
export async function generateSchema(check = false) {
  const { readSchemaManifest } = await portableModule("../src/migrations/schema-reader.ts");
  const { migrations } = await portableModule("../src/generated/migrations.ts");
  const { migrationHistoryTableSql } = await portableModule("../src/migrations/history-sql.ts");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationHistoryTableSql);
    db.exec("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
    for (const record of migrations) {
      for (const statement of record.statements) db.exec(statement);
      db.prepare("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)").run(
        record.hash,
        record.when,
      );
    }
    db.exec("COMMIT; PRAGMA foreign_keys=ON");
    const manifest = await readSchemaManifest(async (sql) => {
      const statement = db.prepare(sql);
      statement.setReturnArrays(true);
      return statement.all();
    });
    const output = fileURLToPath(new URL("../src/generated/schema-manifest.ts", import.meta.url));
    const result = await format(
      output,
      `// Generated from bundled migrations by packages/core/scripts/generate-schema.mjs. Do not edit.
import type { SchemaManifest } from "../schema-types.js";
import { freezeSchema } from "../migrations/schema-reader.js";
export const canonicalSchemaManifest: SchemaManifest = freezeSchema(${JSON.stringify(manifest)});
`,
      {},
    );
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    if (check) {
      if (readFileSync(output, "utf8") !== result.code)
        throw new Error(
          "Canonical schema manifest is stale. Run pnpm --filter @kozane/core migrations:refresh.",
        );
    } else writeFileSync(output, result.code);
  } finally {
    db.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await generateSchema(process.argv.includes("--check"));
