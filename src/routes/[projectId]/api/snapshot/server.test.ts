import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addProject } from "$db/api/project.js";
import { addBundle } from "$db/api/bundle.js";
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

function event(db: DB, projectId: string, headers?: HeadersInit) {
  return {
    locals: { db },
    params: { projectId },
    request: new Request(`http://localhost/${projectId}/api/snapshot`, { headers }),
  } as never;
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  return { db, projectId, bundleId };
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

describe("GET /[projectId]/api/snapshot", () => {
  it("answers 404 for a project that does not exist", async () => {
    const { db } = await setup();
    await expectHttpRejection(GET(event(db, "missing")), 404, "Project not found");
  });

  it("returns the board with a tag describing it", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "Alpha" });

    const response = await GET(event(db, projectId));

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"[\w-]+"$/);
    const body = await response.json();
    expect(body.project).toEqual({ id: projectId });
    expect(body.cards).toMatchObject([{ content: "Alpha" }]);
  });

  it("answers 304 without a body when the client already holds the board", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "Alpha" });
    const first = await GET(event(db, projectId));
    const etag = first.headers.get("etag")!;

    const second = await GET(event(db, projectId, { "if-none-match": etag }));

    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    await expect(second.text()).resolves.toBe("");
  });

  it("answers with the board again once a card changes", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Alpha" });
    const etag = (await GET(event(db, projectId))).headers.get("etag")!;

    // An edit in place: nothing is added or removed, so a tag counting rows would miss it.
    await updateCard({ db, cardId, bundleId, content: "Beta" });

    const response = await GET(event(db, projectId, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).not.toBe(etag);
    expect((await response.json()).cards).toMatchObject([{ content: "Beta" }]);
  });

  it("notices a write that reached the database without passing through the server", async () => {
    // What the poll exists for: `kozane card add` writes to the same file directly, and no
    // counter this server keeps could have seen it.
    const { db, projectId, bundleId } = await setup();
    const etag = (await GET(event(db, projectId))).headers.get("etag")!;

    await addCard({ db, bundleId, content: "From the CLI" });

    const response = await GET(event(db, projectId, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).cards).toMatchObject([{ content: "From the CLI" }]);
  });

  it("does not answer 304 to a tag from another project's board", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "Alpha" });
    const other = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: other, name: "Base", isDefault: true });
    await addBundle({ db, projectId: other, name: "General", isDefault: true });

    const etag = (await GET(event(db, projectId))).headers.get("etag")!;

    const response = await GET(event(db, other, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).project).toEqual({ id: other });
  });

  it("accepts a weak validator and a list of candidates", async () => {
    const { db, projectId } = await setup();
    const etag = (await GET(event(db, projectId))).headers.get("etag")!;

    for (const header of [`W/${etag}`, `"stale", ${etag}`, "*"]) {
      const response = await GET(event(db, projectId, { "if-none-match": header }));
      expect(response.status).toBe(304);
    }
  });

  it("keeps the browser cache out of the exchange", async () => {
    const { db, projectId } = await setup();
    const response = await GET(event(db, projectId));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /[projectId]/api/snapshot — the unchanged-database gate", () => {
  /**
   * A workspace on disk, so the gate has a file to sign. `createTestDB` takes a path for
   * exactly this reason, and pointing `openedDbUrl` at the same one is what makes the
   * signature the endpoint reads the signature of the database it is being handed.
   */
  async function setupOnDisk() {
    const dbPath = join(tmpdir(), `kozane-snapshot-gate-${randomUUID()}.db`);
    const db = await createTestDB(dbPath);
    opened.url = `file:${dbPath}`;
    const projectId = await addProject({ db, name: "Project" });
    await addLayer({ db, projectId, name: "Base", isDefault: true });
    const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
    return { db, projectId, bundleId };
  }

  it("answers 304 without reading the database when nothing has been written", async () => {
    const { db, projectId, bundleId } = await setupOnDisk();
    await addCard({ db, bundleId, content: "Alpha" });
    const etag = (await GET(event(db, projectId))).headers.get("etag")!;

    // The whole point of the gate: the second poll is answered from the file's identity
    // alone, so a database that throws on contact still produces the 304.
    const response = await GET(event(unreadableDb(), projectId, { "if-none-match": etag }));

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
  });

  it("reads again once the database has been written to", async () => {
    const { db, projectId, bundleId } = await setupOnDisk();
    const etag = (await GET(event(db, projectId))).headers.get("etag")!;

    await addCard({ db, bundleId, content: "From the CLI" });

    const response = await GET(event(db, projectId, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).cards).toMatchObject([{ content: "From the CLI" }]);
  });

  it("does not short-circuit a client offering a tag it was never given", async () => {
    const { db, projectId, bundleId } = await setupOnDisk();
    await addCard({ db, bundleId, content: "Alpha" });
    await GET(event(db, projectId));

    const response = await GET(event(db, projectId, { "if-none-match": '"invented"' }));
    expect(response.status).toBe(200);
  });

  it("does not answer one project's board from another project's tag", async () => {
    const { db, projectId } = await setupOnDisk();
    const other = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: other, name: "Base", isDefault: true });
    await addBundle({ db, projectId: other, name: "General", isDefault: true });
    const etag = (await GET(event(db, projectId))).headers.get("etag")!;

    const response = await GET(event(db, other, { "if-none-match": etag }));
    expect(response.status).toBe(200);
    expect((await response.json()).project).toEqual({ id: other });
  });

  it("still answers a first poll in full", async () => {
    const { db, projectId, bundleId } = await setupOnDisk();
    await addCard({ db, bundleId, content: "Alpha" });

    const response = await GET(event(db, projectId));
    expect(response.status).toBe(200);
    expect((await response.json()).cards).toMatchObject([{ content: "Alpha" }]);
  });
});
