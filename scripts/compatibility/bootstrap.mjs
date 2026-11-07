import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { format } from "oxfmt";
import { readCorpus } from "./read-corpus.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** A new cohort is explicit and never overwrites previous producers or expectations. */
export async function bootstrapCorpus({
  consumer,
  archive,
  candidate,
  id,
  run,
  repository,
  driver = "wasm",
  scenarios = "basic",
}) {
  if (!["basic", "boundaries"].includes(scenarios)) throw new Error("Unsupported corpus scenarios");
  if (!["wasm", "libsql"].includes(driver)) throw new Error("Unsupported corpus producer driver");
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(id)) throw new Error("Invalid corpus cohort id");
  const root = join(repository, "tests/compatibility/corpus"),
    target = join(root, id);
  if (existsSync(target)) throw new Error(`Corpus cohort already exists: ${id}`);
  const staging = join(consumer, "corpus-staging");
  mkdirSync(staging);
  const sources = join(consumer, "corpus-tools");
  mkdirSync(sources);
  for (const name of [
    `generate-${driver}.mjs`,
    "seed-corpus.mjs",
    "seed-boundaries.mjs",
    "view-summary.ts",
  ])
    copyFileSync(new URL(name, import.meta.url), join(sources, name));
  for (const name of ["validation.ts", "recovery.ts", "navigation.ts", "attempt.ts"])
    copyFileSync(new URL(`../restoration-harness/${name}`, import.meta.url), join(sources, name));
  copyFileSync(archive, join(staging, "producer.tgz"));
  const artifact = readFileSync(archive);
  writeFileSync(
    join(sources, "producer.json"),
    JSON.stringify({
      scenarios,
      package: candidate.name,
      version: candidate.version,
      status: "unpublished-candidate",
      artifactSha256: sha(artifact),
      artifactBytes: artifact.length,
      drizzleVersion: candidate.dependencies["drizzle-orm"],
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
    }),
  );
  run(
    process.execPath,
    [
      "--import",
      resolve(repository, "node_modules/tsx/dist/loader.mjs"),
      join(sources, `generate-${driver}.mjs`),
      staging,
      join(sources, "producer.json"),
    ],
    consumer,
  );
  const manifestPath = join(staging, "manifest.json");
  const formatted = await format(manifestPath, readFileSync(manifestPath, "utf8"), {});
  if (formatted.errors.length) throw new Error("Cannot format corpus manifest");
  writeFileSync(manifestPath, formatted.code);
  const indexPath = join(root, "index.json");
  const originalIndex = existsSync(indexPath) ? readFileSync(indexPath) : undefined;
  if (originalIndex) readCorpus(root);
  const index = originalIndex ? JSON.parse(originalIndex) : { format: 1, cohorts: [] };
  const next = {
    ...index,
    cohorts: [...index.cohorts, { id, sha256: sha(readFileSync(join(staging, "manifest.json"))) }],
  };
  for (const entry of index.cohorts)
    if (entry.id === id) throw new Error("Duplicate corpus cohort id");
  mkdirSync(root, { recursive: true });
  try {
    cpSync(staging, target, { recursive: true, errorOnExist: true, force: false });
    const result = await format(indexPath, JSON.stringify(next), {});
    if (result.errors.length) throw new Error("Cannot format corpus index");
    writeFileSync(indexPath, result.code);
    readCorpus(root);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (originalIndex) writeFileSync(indexPath, originalIndex);
    else rmSync(indexPath, { force: true });
    throw error;
  }
  console.log(`Bootstrapped retained cohort ${id}. Existing cohorts were preserved.`);
}
