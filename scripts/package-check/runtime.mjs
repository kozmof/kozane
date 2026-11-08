import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
export async function checkCoreRuntime({
  repository,
  temporary,
  run,
  installed,
  manifest,
  entries,
}) {
  const publicTypes = readFileSync(resolve(installed, manifest.exports["."].types), "utf8");
  // Each fresh process must initialize the public entry without a prior root import.
  for (const entry of ["@kozane/core/database", "@kozane/core/services", "@kozane/core/schema"])
    run(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entry)})`],
      temporary,
    );
  for (const path of [
    "inventory",
    "squash",
    "constants/inventory",
    "tag/syntax",
    "tag/scan",
    "tag/hits",
    "tag/tree",
    "urls",
    "palette",
    "order",
    "constants/limits",
    "constants/domain",
    "byte-length",
    "plain-object",
    "entry-name",
    "error-message",
    "constants/taskspace",
  ]) {
    assert.ok(
      entries.has(`package/dist/packages/core/src/${path}.js`),
      `Missing owned helper: ${path}`,
    );
    if (!entries.has(`package/dist/src/lib/${path}.js`)) continue;
    const compatibility = readFileSync(join(installed, "dist/src/lib", `${path}.js`), "utf8");
    assert.match(
      compatibility,
      /^export \{[\w\s,]*\} from "@kozane\/core";\s*$/,
      `Core must own helper implementation: ${path}`,
    );
  }
  for (const topic of ["canvas", "workspace", "tag"])
    assert.ok(
      entries.has(`package/dist/packages/core/src/constants/${topic}.js`),
      `Missing owned constants: ${topic}`,
    );
  for (const name of ["database-types", "types"]) {
    assert.ok(publicTypes.includes(`"./${name}.js"`), `Missing owned ${name} export`);
    const declaration = readFileSync(
      join(installed, "dist/packages/core/src", `${name}.d.ts`),
      "utf8",
    );
    assert.ok(
      !declaration.includes("/src/"),
      `Domain declarations must use core-owned types: ${name}`,
    );
  }
  writeFileSync(
    join(temporary, "runtime.mjs"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-runtime.mjs")),
  );
  run(process.execPath, [join(temporary, "runtime.mjs")], temporary);
  const referencePath = join(temporary, "reference.sqlite");
  const referenceClient = createClient({ url: `file:${referencePath}` });
  try {
    await migrate(drizzle(referenceClient), { migrationsFolder: join(repository, "drizzle") });
  } finally {
    referenceClient.close();
  }
  writeFileSync(
    join(temporary, "migrations.mjs"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-migrations.mjs")),
  );
  console.log(
    run(process.execPath, [join(temporary, "migrations.mjs"), referencePath], temporary).trim(),
  );
  writeFileSync(
    join(temporary, "schema.mjs"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-schema.mjs")),
  );
  console.log(run(process.execPath, [join(temporary, "schema.mjs")], temporary).trim());
  writeFileSync(
    join(temporary, "consumer.ts"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-types.ts")),
  );
  writeFileSync(
    join(temporary, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: ["consumer.ts"],
    }),
  );
  run(
    process.execPath,
    [
      join(repository, "node_modules/typescript/bin/tsc"),
      "--project",
      join(temporary, "tsconfig.json"),
    ],
    temporary,
  );
  writeFileSync(
    join(temporary, "drivers.mjs"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-drivers.mjs")),
  );
  console.log(run(process.execPath, [join(temporary, "drivers.mjs")], temporary).trim());
}
