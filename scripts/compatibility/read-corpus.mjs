import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
/** @param {Uint8Array} bytes */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Verify every retained byte and manifest before a candidate can inspect the corpus.
 * @param {string} root
 */
export function readCorpus(root) {
  const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
  if (index.format !== 1 || !Array.isArray(index.cohorts) || !index.cohorts.length)
    throw new Error("Invalid corpus index");
  const ids = new Set();
  const cohorts = [];
  for (const record of index.cohorts) {
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(record.id) || ids.has(record.id))
      throw new Error("Invalid or duplicate corpus cohort");
    ids.add(record.id);
    const directory = join(root, record.id),
      manifestBytes = readFileSync(join(directory, "manifest.json"));
    if (hash(manifestBytes) !== record.sha256)
      throw new Error(`Corpus manifest changed: ${record.id}`);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (
      manifest.format !== 1 ||
      typeof manifest.migrationId !== "string" ||
      !manifest.migrationId ||
      !Array.isArray(manifest.fixtures) ||
      !manifest.fixtures.length
    )
      throw new Error("Invalid corpus manifest");
    const archive = readFileSync(join(directory, "producer.tgz"));
    if (
      hash(archive) !== manifest.producer.artifactSha256 ||
      archive.length !== manifest.producer.artifactBytes
    )
      throw new Error(`Producer artifact changed: ${record.id}`);
    const names = new Set();
    for (const fixture of manifest.fixtures) {
      if (!/^[a-z0-9][a-z0-9.-]*\.sqlite3$/.test(fixture.file) || names.has(fixture.file))
        throw new Error("Invalid or duplicate fixture filename");
      names.add(fixture.file);
      const bytes = readFileSync(join(directory, fixture.file));
      if (bytes.length !== fixture.size || hash(bytes) !== fixture.sha256)
        throw new Error(`Retained fixture changed: ${record.id}/${fixture.file}`);
      if (!bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")))
        throw new Error("Invalid retained database header");
      if (!Array.isArray(fixture.expected) || !fixture.expected.length)
        throw new Error("Missing retained view expectations");
      for (const expected of fixture.expected)
        if (
          expected.view?.version !== 1 ||
          !["empty", "selected", "missing", "selection_required"].includes(expected.view.kind)
        )
          throw new Error("Invalid retained view expectation");
    }
    cohorts.push({ id: record.id, directory, ...manifest });
  }
  return cohorts;
}
