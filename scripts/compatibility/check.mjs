import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCorpus } from "./read-corpus.mjs";
/** Check original bytes with the installed candidate. Never regenerate expectations. */
export function checkCorpus({ consumer, repository, run, client = false }) {
  const root = join(repository, "tests/compatibility/corpus");
  readCorpus(root);
  const sources = join(consumer, "corpus-check");
  mkdirSync(sources);
  for (const name of ["run-corpus.mjs", "read-corpus.mjs", "view-summary.ts"])
    copyFileSync(new URL(name, import.meta.url), join(sources, name));
  for (const name of [
    "validation.ts",
    "recovery.ts",
    "navigation.ts",
    "attempt.ts",
    "corpus-compatibility.ts",
  ])
    copyFileSync(new URL(`../restoration-harness/${name}`, import.meta.url), join(sources, name));
  console.log(
    run(
      process.execPath,
      [
        "--import",
        resolve(repository, "node_modules/tsx/dist/loader.mjs"),
        join(sources, "run-corpus.mjs"),
        root,
        ...(client ? ["--client"] : []),
      ],
      consumer,
    ).trim(),
  );
}
