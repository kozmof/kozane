import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addNamespace } from "$db/api/namespace.js";
import { addPartition } from "$db/api/partition.js";
import { addLayer } from "$db/api/layer.js";
import { addCard, updateCard } from "$db/api/card.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { _resetSnapshotEtagsForTest } from "$lib/server/snapshot-etag.js";
import { GET } from "./+server.js";

/**
 * Which database the endpoint believes it is serving. Real `openedDbUrl` answers null until
 * `getDb` has opened one, which never happens in this process — so the ETag gate is off for
 * every test below except the ones that switch it on by naming a file here.
 */
const opened = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("$db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$db/client")>()),
  openedDbUrl: () => opened.url,
}));

beforeEach(() => {
  opened.url = null;
  _resetSnapshotEtagsForTest();
});

/** A database that fails if it is read from, for asserting that a read did not happen. */
function unreadableDb(): DB {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`snapshot read the database (.${String(property)})`);
      },
    },
  ) as DB;
}

function event(db: DB, namespaceId: string, headers?: HeadersInit) {
  return {
    locals: { db },
    params: { namespaceId },
    request: new Request(`http://localhost/${namespaceId}/api/snapshot`, { headers }),
  } as never;
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  return { db, namespaceId, partitionId };
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

describe("GET /[namespaceId]/api/snapshot", () => {
  it("answers 404 for a namespace that does not exist", async () => {
    const { db } = await setup();
    await expectHttpRejection(GET(event(db, "missing")), 404, "Namespace not found");
  });

  it("returns the board with a tag describing it", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "Alpha" });

    const response = await GET(event(db, namespaceId));

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"[\w-]+"$/);
    const body = await response.json();
    expect(body.namespace).toEqual({ id: namespaceId });
    expect(body.cards).toMatchObject([{ content: "Alpha" }]);
  });

  it("answers 304 without a body when the client already holds the board", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "Alpha" });
    const first = await GET(event(db, namespaceId));
    const etag = first.headers.get("etag")!;

    const second = await GET(event(db, namespaceId, { "if-none-match": etag }));

    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    await expect(second.text()).resolves.toBe("");
  });

  it("answers with the board again once a card changes", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Alpha" });
    const etag = (await GET(event(db, namespaceId))).headers.get("etag")!;

    // An edit in place: nothing is added or removed, so a tag counting rows would miss it.
    await updateCard({ db, cardId, partitionId, content: "Beta" });

    const response = await GET(event(db, namespaceId, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).not.toBe(etag);
    expect((await response.json()).cards).toMatchObject([{ content: "Beta" }]);
  });

  it("notices a write that reached the database without passing through the server", async () => {
    // What the poll exists for: `kozane card add` writes to the same file directly, and no
    // counter this server keeps could have seen it.
    const { db, namespaceId, partitionId } = await setup();
    const etag = (await GET(event(db, namespaceId))).headers.get("etag")!;

    await addCard({ db, partitionId, content: "From the CLI" });

    const response = await GET(event(db, namespaceId, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).cards).toMatchObject([{ content: "From the CLI" }]);
  });

  it("does not answer 304 to a tag from another namespace's board", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "Alpha" });
    const other = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: other, name: "Base", isDefault: true });
    await addPartition({ db, namespaceId: other, name: "General", isDefault: true });

    const etag = (await GET(event(db, namespaceId))).headers.get("etag")!;

    const response = await GET(event(db, other, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).namespace).toEqual({ id: other });
  });

  it("accepts a weak validator and a list of candidates", async () => {
    const { db, namespaceId } = await setup();
    const etag = (await GET(event(db, namespaceId))).headers.get("etag")!;

    for (const header of [`W/${etag}`, `"stale", ${etag}`, "*"]) {
      const response = await GET(event(db, namespaceId, { "if-none-match": header }));
      expect(response.status).toBe(304);
    }
  });

  it("keeps the browser cache out of the exchange", async () => {
    const { db, namespaceId } = await setup();
    const response = await GET(event(db, namespaceId));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /[namespaceId]/api/snapshot — the unchanged-database gate", () => {
  /**
   * A workspace on disk, so the gate has a file to sign. `createTestDB` takes a path for
   * exactly this reason, and pointing `openedDbUrl` at the same one is what makes the
   * signature the endpoint reads the signature of the database it is being handed.
   */
  async function setupOnDisk() {
    const dbPath = join(tmpdir(), `kozane-snapshot-gate-${randomUUID()}.db`);
    const db = await createTestDB(dbPath);
    opened.url = `file:${dbPath}`;
    const namespaceId = await addNamespace({ db, name: "Namespace" });
    await addLayer({ db, namespaceId, name: "Base", isDefault: true });
    const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
    return { db, namespaceId, partitionId };
  }

  it("answers 304 without reading the database when nothing has been written", async () => {
    const { db, namespaceId, partitionId } = await setupOnDisk();
    await addCard({ db, partitionId, content: "Alpha" });
    const etag = (await GET(event(db, namespaceId))).headers.get("etag")!;

    // The whole point of the gate: the second poll is answered from the file's identity
    // alone, so a database that throws on contact still produces the 304.
    const response = await GET(event(unreadableDb(), namespaceId, { "if-none-match": etag }));

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
  });

  it("reads again once the database has been written to", async () => {
    const { db, namespaceId, partitionId } = await setupOnDisk();
    const etag = (await GET(event(db, namespaceId))).headers.get("etag")!;

    await addCard({ db, partitionId, content: "From the CLI" });

    const response = await GET(event(db, namespaceId, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).cards).toMatchObject([{ content: "From the CLI" }]);
  });

  it("does not short-circuit a client offering a tag it was never given", async () => {
    const { db, namespaceId, partitionId } = await setupOnDisk();
    await addCard({ db, partitionId, content: "Alpha" });
    await GET(event(db, namespaceId));

    const response = await GET(event(db, namespaceId, { "if-none-match": '"invented"' }));
    expect(response.status).toBe(200);
  });

  it("does not answer one namespace's board from another namespace's tag", async () => {
    const { db, namespaceId } = await setupOnDisk();
    const other = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: other, name: "Base", isDefault: true });
    await addPartition({ db, namespaceId: other, name: "General", isDefault: true });
    const etag = (await GET(event(db, namespaceId))).headers.get("etag")!;

    const response = await GET(event(db, other, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).namespace).toEqual({ id: other });
  });

  it("still answers a first poll in full", async () => {
    const { db, namespaceId, partitionId } = await setupOnDisk();
    await addCard({ db, partitionId, content: "Alpha" });

    const response = await GET(event(db, namespaceId));
    expect(response.status).toBe(200);
    expect((await response.json()).cards).toMatchObject([{ content: "Alpha" }]);
  });
});
