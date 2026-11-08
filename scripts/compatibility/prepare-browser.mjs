import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCorpus } from "./read-corpus.mjs";
/** Copy only hash-verified original databases into the disposable harness build.
 * @param {string} root
 * @param {string} output
 */
export function prepareBrowserCorpus(root, output) {
  const fixtures = [];
  for (const cohort of readCorpus(root)) {
    const directory = join(output, "corpus", cohort.id);
    mkdirSync(directory, { recursive: true });
    for (const fixture of cohort.fixtures) {
      copyFileSync(join(cohort.directory, fixture.file), join(directory, fixture.file));
      fixtures.push({
        cohort: cohort.id,
        migrationId: cohort.migrationId,
        id: fixture.id,
        url: `/corpus/${cohort.id}/${fixture.file}`,
        sha256: fixture.sha256,
        size: fixture.size,
        expected: fixture.expected,
      });
    }
  }
  writeFileSync(join(output, "corpus.json"), JSON.stringify({ format: 1, fixtures }));
  return fixtures;
}
