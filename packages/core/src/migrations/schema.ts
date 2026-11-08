import { sql } from "drizzle-orm";
import { withReadTx, type DB } from "../database.js";
import { SchemaMismatchError } from "./errors.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { freezeSchema, readSchemaManifest } from "./schema-reader.js";
import type { SchemaComparison, SchemaManifest } from "../schema-types.js";

/** Compare deterministic manifests without changing either input. */
export function compareSchemaManifests(
  actual: SchemaManifest,
  expected: SchemaManifest = canonicalSchemaManifest,
): SchemaComparison {
  const key = (object: SchemaManifest[number]) => `${object.type}:${object.name}`;
  const candidate = new Map(actual.map((object) => [key(object), object]));
  const required = new Map(expected.map((object) => [key(object), object]));
  const missing = [...required.keys()].filter((key) => !candidate.has(key)).sort();
  const unexpected = [...candidate.keys()].filter((key) => !required.has(key)).sort();
  const altered = [...required.keys()]
    .filter(
      (key) =>
        candidate.has(key) &&
        JSON.stringify(candidate.get(key)) !== JSON.stringify(required.get(key)),
    )
    .sort();
  return freezeSchema({
    matches: missing.length + unexpected.length + altered.length === 0,
    missing,
    unexpected,
    altered,
  });
}
/** Inspect and compare one consistent database snapshot without executing any repairs. */
export async function validateDatabaseSchema(db: DB): Promise<SchemaComparison> {
  return withReadTx(db, async (tx) => {
    const manifest = await readSchemaManifest(async (query) =>
      (await tx.values<unknown[]>(sql.raw(query))).map((row) => Array.from(row)),
    );
    const comparison = compareSchemaManifests(manifest);
    if (!comparison.matches) throw new SchemaMismatchError(comparison);
    return comparison;
  });
}
