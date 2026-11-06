import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const originalSelf = globalThis.self;
const pending = new Map();
const replies = [];
let sequence = 0;
const instanceId = "node-worker-check";
const scope = {
  onmessage: undefined,
  postMessage(message) {
    assert.equal(message.instanceId, instanceId);
    replies.push(message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  },
};
globalThis.self = scope;
function rpc(method, extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    scope.onmessage({ data: { ...extra, id, instanceId, method } });
  });
}
try {
  await import(pathToFileURL(process.argv[2]).href);
  const first = rpc("probe");
  assert.equal(replies.length, 1);
  assert.equal(await first, process.argv[5]);
  scope.onmessage({ data: { id: 999, instanceId: "wrong-worker", method: "probe" } });
  assert.equal(replies.length, 1);
  const module = await WebAssembly.compile(readFileSync(process.argv[3]));
  const initializing = rpc("initialize", { module });
  const fast = rpc("probe");
  assert.equal(replies.at(-1).id, 3);
  assert.equal(await fast, process.argv[5]);
  await initializing;
  await rpc("open", { bytes: new Uint8Array(readFileSync(process.argv[4])) });
  const original = (await rpc("values", { sql: "SELECT content FROM card ORDER BY id" })).rows;
  await rpc("run", { sql: "BEGIN IMMEDIATE" });
  await rpc("run", { sql: "UPDATE card SET content='uncommitted worker fixture'" });
  assert.equal(await rpc("connection"), true);
  assert.equal(
    (await rpc("values", { sql: "SELECT content FROM card ORDER BY id" })).rows[0][0],
    "uncommitted worker fixture",
  );
  await rpc("run", { sql: "ROLLBACK" });
  assert.deepEqual(
    (await rpc("values", { sql: "SELECT content FROM card ORDER BY id" })).rows,
    original,
  );
  const queued = rpc("values", { sql: "SELECT 1" });
  const fastId = sequence + 1;
  const probe = rpc("probe");
  assert.equal(replies.at(-1).id, fastId);
  assert.equal(await probe, process.argv[5]);
  await queued;
  await rpc("close");
  await assert.rejects(rpc("connection"), /Candidate database operation failed/);
  assert.equal(pending.size, 0);
} finally {
  if (originalSelf === undefined) delete globalThis.self;
  else globalThis.self = originalSelf;
}
console.log(
  "Bundled worker instance envelopes, independent probes and read-only transaction-preserving checks passed under Node.",
);
