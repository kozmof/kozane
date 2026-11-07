import { afterEach, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openDb } from "./client.js";
import { nodeCommitRevision } from "./tx.js";
import { fileDbUrl } from "../lib/db-url.js";
const roots: string[] = [];
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function open(url: string) {
  const opened = await openDb(url);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      opened.close();
    }
  };
  closes.push(close);
  return { db: opened.db, close };
}
function path() {
  const root = mkdtempSync(join(tmpdir(), "kozane-db-identity-"));
  roots.push(root);
  return join(root, "workspace notes.db");
}
it("shares revisions across URL aliases and reopened handles for the same file", async () => {
  const file = path();
  const first = await open(fileDbUrl(file));
  await first.db.run(sql`CREATE TABLE fixture(value TEXT)`);
  const second = await open(`file:${file}`);
  expect(nodeCommitRevision(second.db)).toEqual(nodeCommitRevision(first.db));
  const before = nodeCommitRevision(first.db).revision;
  await second.db.run(sql`INSERT INTO fixture VALUES ('second handle')`);
  expect(nodeCommitRevision(first.db).revision).toBe(before + 1);
  expect(nodeCommitRevision(second.db)).toEqual(nodeCommitRevision(first.db));
  second.close();
  first.close();
  const reopened = await open(fileDbUrl(file));
  expect(nodeCommitRevision(reopened.db)).toEqual(nodeCommitRevision(first.db));
});
it("gives a replaced database a new nonce while the old DB reference remains alive", async () => {
  const file = path();
  const first = await open(fileDbUrl(file));
  await first.db.run(sql`CREATE TABLE fixture(value TEXT)`);
  const before = nodeCommitRevision(first.db);
  first.close();
  const replacement = file + ".replacement";
  copyFileSync(file, replacement);
  renameSync(replacement, file);
  const next = await open(fileDbUrl(file));
  expect(nodeCommitRevision(next.db).nonce).not.toBe(before.nonce);
  expect(nodeCommitRevision(first.db)).toEqual(before);
  expect(nodeCommitRevision(next.db).revision).toBe(0);
});
it("keeps independent memory sessions distinct even when their requested URL matches", async () => {
  const first = await open(":memory:");
  const second = await open(":memory:");
  const before = nodeCommitRevision(second.db);
  expect(nodeCommitRevision(first.db).nonce).not.toBe(before.nonce);
  await first.db.run(sql`CREATE TABLE fixture(value TEXT)`);
  expect(nodeCommitRevision(second.db)).toEqual(before);
});
