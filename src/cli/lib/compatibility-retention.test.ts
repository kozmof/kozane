import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { checkCorpusRetention } from "../../../scripts/compatibility/retention.mjs";
import { readCorpus } from "../../../scripts/compatibility/read-corpus.mjs";
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function directory() {
  const root = mkdtempSync(join(tmpdir(), "kozane-retention-test-"));
  temporary.push(root);
  return root;
}
function git(root: string, args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=Corpus Test", "-c", "user.email=corpus@example.invalid", ...args],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  );
}
const corpus = (root: string) => join(root, "tests/compatibility/corpus");
function index(root: string) {
  return JSON.parse(readFileSync(join(corpus(root), "index.json"), "utf8"));
}
function writeIndex(root: string, value: unknown) {
  writeFileSync(join(corpus(root), "index.json"), JSON.stringify(value));
}
function commit(root: string) {
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Retain corpus"]);
}
function add(root: string, id: string) {
  const path = join(corpus(root), id);
  mkdirSync(path, { recursive: true });
  // Synthetic hash records exercise retention only. Packed checks validate real producer archives and SQLite data.
  const producer = Buffer.from("synthetic producer");
  const database = Buffer.from("SQLite format 3\0synthetic fixture");
  writeFileSync(join(path, "producer.tgz"), producer);
  writeFileSync(join(path, "empty.sqlite3"), database);
  const manifest = JSON.stringify({
    format: 1,
    migrationId: "migration",
    producer: { artifactSha256: hash(producer), artifactBytes: producer.length },
    fixtures: [
      {
        id: "empty",
        file: "empty.sqlite3",
        size: database.length,
        sha256: hash(database),
        expected: [{ view: { version: 1, kind: "empty" } }],
      },
    ],
  });
  writeFileSync(join(path, "manifest.json"), manifest);
  let current;
  try {
    current = index(root);
  } catch {
    current = { format: 1, cohorts: [] };
  }
  current.cohorts.push({ id, sha256: hash(manifest) });
  writeIndex(root, current);
}
function repository() {
  const root = directory();
  git(root, ["init", "-q", "--initial-branch=main"]);
  add(root, "first");
  commit(root);
  return root;
}
function rewriteManifest(root: string, change: (value: any) => void) {
  const path = join(corpus(root), "first/manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest);
  const bytes = JSON.stringify(manifest);
  writeFileSync(path, bytes);
  const current = index(root);
  current.cohorts[0].sha256 = hash(bytes);
  writeIndex(root, current);
}
it("accepts appended cohorts against all historical indexes", () => {
  const root = repository();
  add(root, "second");
  expect(checkCorpusRetention(root)).toEqual({ cohorts: 2, revisions: 1 });
  commit(root);
  expect(checkCorpusRetention(root)).toEqual({ cohorts: 2, revisions: 2 });
});
it.each(["expectation", "database", "producer"])(
  "rejects rewritten %s even when every current hash matches",
  (kind) => {
    const root = repository();
    rewriteManifest(root, (manifest) => {
      if (kind === "expectation") manifest.fixtures[0].expected[0].view.kind = "missing";
      else if (kind === "database") {
        const bytes = Buffer.from("SQLite format 3\0changed fixture");
        writeFileSync(join(corpus(root), "first/empty.sqlite3"), bytes);
        Object.assign(manifest.fixtures[0], { size: bytes.length, sha256: hash(bytes) });
      } else {
        const bytes = Buffer.from("changed producer");
        writeFileSync(join(corpus(root), "first/producer.tgz"), bytes);
        Object.assign(manifest.producer, {
          artifactBytes: bytes.length,
          artifactSha256: hash(bytes),
        });
      }
    });
    expect(readCorpus(corpus(root))).toHaveLength(1);
    expect(() => checkCorpusRetention(root)).toThrow(/must remain unchanged/);
    commit(root);
    expect(() => checkCorpusRetention(root)).toThrow(/must remain unchanged/);
  },
);
it.each(["remove", "reorder"])("rejects an index that tries to %s earlier records", (kind) => {
  const root = repository();
  add(root, "second");
  commit(root);
  const current = index(root);
  if (kind === "remove") current.cohorts.shift();
  else current.cohorts.reverse();
  writeIndex(root, current);
  expect(() => checkCorpusRetention(root)).toThrow(/must remain unchanged/);
});
it("fails closed on a shallow checkout", () => {
  const original = repository();
  add(original, "second");
  commit(original);
  const clone = directory();
  git(clone, ["clone", "-q", "--depth=1", pathToFileURL(original).href, "."]);
  expect(() => checkCorpusRetention(clone)).toThrow(/full Git history/);
});
