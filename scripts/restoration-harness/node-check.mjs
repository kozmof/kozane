import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter, createServiceContext } from "@kozane/core/database";
import { cards } from "@kozane/core/services";
import { ResetSession } from "./reset.ts";
import { OperationQueue } from "./operation-queue.ts";
import { schemaVersion } from "@kozane/core/migrations";
import * as schema from "@kozane/core/schema";
import { AttemptOwner } from "./attempt.ts";
import { DestinationTracker } from "./navigation.ts";
import { validateCandidate } from "./validation.ts";
import { restoreCandidate, HarnessFailure } from "./recovery.ts";
const sqlite = await sqlite3InitModule();
const sample = new Uint8Array(readFileSync(process.argv[2]));
const sampleNamespaceId = process.argv[3];
let active = false;
let independentSequence = 0;
const openHandles = new Set();
function open(bytes, independent = false) {
  if (!independent)
    assert.equal(active, false, "Rejected or preflight candidate must close before another opens");
  const filename = independent ? `/staged-${++independentSequence}.db` : "/candidate.db";
  sqlite.capi.sqlite3_js_posix_create_file(filename, bytes);
  let engine;
  try {
    engine = new sqlite.oo1.DB(filename, "w");
    if (!independent) active = true;
    engine.exec("PRAGMA foreign_keys=ON");
  } catch (error) {
    engine?.close();
    if (!independent) active = false;
    const code = error instanceof sqlite.SQLite3Error ? error.resultCode & 255 : 0;
    throw new HarnessFailure(
      code === 11 || code === 26 ? "database_content" : "unknown",
      "Candidate open failed",
    );
  }
  openHandles.add(engine);
  const handle = drizzle(
    async (sql, args, method) => {
      try {
        const rows = [];
        engine.exec({ sql, bind: args, rowMode: "array", resultRows: rows });
        return { rows: method === "get" ? (rows[0] ?? []) : rows };
      } catch (error) {
        const code = error instanceof sqlite.SQLite3Error ? error.resultCode & 255 : 0;
        throw new HarnessFailure(
          code === 11 || code === 26 ? "database_content" : "unknown",
          "Database operation failed",
        );
      }
    },
    { schema },
  );
  const db = createDatabaseAdapter(handle, {
    read: async (operation) => {
      engine.exec("BEGIN DEFERRED");
      try {
        const result = await operation(handle);
        engine.exec("COMMIT");
        return result;
      } catch (error) {
        engine.exec("ROLLBACK");
        throw error;
      }
    },
    write: async (operation) => {
      if (!independent) throw new Error("Restoration must not write");
      engine.exec("BEGIN IMMEDIATE");
      try {
        const result = await operation(handle);
        engine.exec("COMMIT");
        return result;
      } catch (error) {
        engine.exec("ROLLBACK");
        throw error;
      }
    },
  });
  return {
    validate: (request) => validateCandidate(db, request),
    close: async () => {
      if (!openHandles.delete(engine)) return;
      engine.close();
      if (!independent) active = false;
    },
    engine,
    db,
  };
}
function envelope(bytes) {
  return JSON.stringify({ schemaVersion, savedAt: 0, db: Buffer.from(bytes).toString("base64") });
}
async function run(saved, namespaceId, sampleOverride = sample) {
  let copy = saved,
    deleted = false;
  const result = await restoreCandidate({
    schemaVersion,
    namespaceId,
    storage: () => ({
      getItem: () => copy,
      removeItem: () => {
        copy = null;
        deleted = true;
      },
    }),
    sample: async () => ({ bytes: sampleOverride, namespaceId: sampleNamespaceId }),
    open: async (bytes) => open(bytes),
  });
  if (result.status === "ready") await result.candidate.close();
  return { result, copy, deleted };
}
assert.equal((await run(null)).result.source, "sample");
assert.equal((await run(envelope(sample))).result.source, "restored");
assert.equal((await run(envelope(sample), "missing-id")).result.view.kind, "missing");
for (const alter of [
  "DELETE FROM __drizzle_migrations WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)",
  "DROP INDEX scope_rel_card",
  "DROP TRIGGER card_stamp_missing_timestamps",
  "PRAGMA foreign_keys=OFF; INSERT INTO scope(id,name) VALUES ('dangling','Outside initial namespace'); INSERT INTO scope_rel(scope_id,card_id) VALUES ('dangling','absent-card')",
]) {
  const candidate = open(sample);
  candidate.engine.exec(alter);
  const bytes = sqlite.capi.sqlite3_js_db_export(candidate.engine.pointer);
  await candidate.close();
  const result = await run(envelope(bytes));
  assert.equal(result.result.status, "ready");
  assert.equal(result.result.source, "sample");
  assert.equal(result.result.fallbackReason, "database_content");
  assert.equal(result.deleted, true);
}
const corrupt = await run(envelope(new Uint8Array([1, 2, 3])));
assert.equal(corrupt.result.source, "sample");
assert.equal(corrupt.deleted, true);
const empty = open(sample);
empty.engine.exec("DELETE FROM namespace");
const emptyBytes = sqlite.capi.sqlite3_js_db_export(empty.engine.pointer);
await empty.close();
const result = await run(envelope(emptyBytes));
assert.equal(result.result.source, "restored");
assert.equal(result.result.view.kind, "empty");
assert.equal(result.deleted, false);
const invalidSample = await run("malformed", undefined, emptyBytes);
assert.equal(invalidSample.result.status, "unavailable");
assert.equal(invalidSample.result.action, "reload");
assert.equal(invalidSample.copy, "malformed");
assert.equal(invalidSample.deleted, false);
const navigating = open(sample);
const navigation = new DestinationTracker("obsolete-id");
let release, entered;
const gate = new Promise((resolve) => {
  release = resolve;
});
const waiting = new Promise((resolve) => {
  entered = resolve;
});
const changing = navigating.validate({
  navigation,
  beforeView: async (id) => {
    if (id === "obsolete-id") {
      entered();
      await gate;
      throw new HarnessFailure("database_content", "obsolete read defect");
    }
  },
});
await waiting;
navigation.select(sampleNamespaceId);
release();
assert.equal((await changing).namespaceId, sampleNamespaceId);
await navigating.close();
const attempts = new AttemptOwner();
let savedAttemptCopy = "malformed",
  releaseAttempt,
  enteredAttempt;
const attemptGate = new Promise((resolve) => {
  releaseAttempt = resolve;
});
const attemptWaiting = new Promise((resolve) => {
  enteredAttempt = resolve;
});
const obsolete = restoreCandidate({
  schemaVersion,
  attempt: attempts.begin(),
  storage: () => ({
    getItem: () => savedAttemptCopy,
    removeItem: () => {
      savedAttemptCopy = "deleted";
    },
  }),
  sample: async () => ({ bytes: sample, namespaceId: sampleNamespaceId }),
  open: async (bytes) => open(bytes),
  beforeView: async () => {
    enteredAttempt();
    await attemptGate;
  },
});
await attemptWaiting;
attempts.replaceGeneration();
savedAttemptCopy = "newer copy";
releaseAttempt();
assert.deepEqual(await obsolete, { status: "superseded" });
assert.equal(savedAttemptCopy, "newer copy");
assert.equal(active, false);
for (const fixtureSQL of [
  undefined,
  "DROP INDEX scope_rel_card",
  "PRAGMA foreign_keys=OFF; INSERT INTO scope(id,name) VALUES ('dangling','Outside current view'); INSERT INTO scope_rel(scope_id,card_id) VALUES ('dangling','absent-card')",
]) {
  const live = open(sample, true);
  const view = await live.validate({ namespaceId: sampleNamespaceId });
  await cards.create(live.db, createServiceContext(), sampleNamespaceId, {
    partitionId: view.snapshot.snapshot.partitions[0].id,
    content: "Retained public-service edit",
  });
  const queue = new OperationQueue();
  const session = new ResetSession(
    { generation: 0, candidate: live, view, namespaceId: sampleNamespaceId, url: "/tags/#private" },
    (operation) => queue.run(operation),
  );
  let saved = "saved copy",
    url = "/tags/#private";
  const result = await session.reset({
    sample: async () => ({ bytes: sample, namespaceId: sampleNamespaceId }),
    open: async (bytes) => {
      const staged = open(bytes, true);
      if (fixtureSQL) staged.engine.exec(fixtureSQL);
      return staged;
    },
    storage: () => ({
      getItem: () => saved,
      removeItem: () => {
        assert.equal(session.state.generation, 1);
        saved = null;
      },
    }),
    destination: (id) => `/board/?namespaceId=${id}`,
    navigate: (next) => {
      url = next;
    },
  });
  const actual = await session.state.candidate.validate({ namespaceId: sampleNamespaceId });
  if (fixtureSQL) {
    assert.equal(result.status, "unavailable");
    assert.equal(result.action, "reload");
    assert.equal(session.state.generation, 0);
    assert.equal(saved, "saved copy");
    assert.equal(url, "/tags/#private");
    assert.equal(actual.snapshot.snapshot.cards.length, 2);
    assert.equal(openHandles.has(live.engine), true);
  } else {
    assert.equal(result.status, "ready");
    assert.equal(session.state.generation, 1);
    assert.equal(saved, null);
    assert.equal(url, `/board/?namespaceId=${sampleNamespaceId}`);
    assert.equal(actual.snapshot.snapshot.cards.length, 1);
    assert.equal(openHandles.has(live.engine), false);
  }
  assert.equal(openHandles.size, 1);
  await session.state.candidate.close();
  assert.equal(openHandles.size, 0);
}
console.log(
  "Restoration, staged reset and candidate validation passed with packed core and real wasm bytes under Node.",
);
