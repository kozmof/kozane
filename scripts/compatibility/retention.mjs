import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCorpus } from "./read-corpus.mjs";
const indexPath = "tests/compatibility/corpus/index.json";
/** Verify retained index records against every reachable committed version.
 * @param {string} repository
 */
export function checkCorpusRetention(repository) {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: "pipe" }).trim();
  assert.equal(
    git(["rev-parse", "--is-shallow-repository"]),
    "false",
    "Corpus retention needs full Git history. Fetch with --unshallow or use fetch-depth: 0 in CI.",
  );
  const cohorts = readCorpus(join(repository, "tests/compatibility/corpus"));
  const current = JSON.parse(readFileSync(join(repository, indexPath), "utf8"));
  const revisions = git(["log", "--full-history", "--format=%H", "HEAD", "--", indexPath])
    .split("\n")
    .filter(Boolean);
  assert.ok(revisions.length, "Commit the initial corpus before running release checks");
  for (const revision of revisions) {
    const previous = JSON.parse(git(["show", `${revision}:${indexPath}`]));
    assert.ok(
      previous.format === 1 && Array.isArray(previous.cohorts) && previous.cohorts.length,
      `Invalid historical corpus index at ${revision}`,
    );
    assert.deepEqual(
      current.cohorts.slice(0, previous.cohorts.length),
      previous.cohorts,
      `Retained corpus records must remain unchanged and in order (${revision})`,
    );
  }
  return { cohorts: cohorts.length, revisions: revisions.length };
}
