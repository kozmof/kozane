import { afterEach, beforeEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { brandDb, migrateNodeDatabase } from "../../db/tx.js";
import * as schema from "../../db/schema.js";
import { createNamespace } from "../../db/api/namespace.js";

const worker = resolve("packages/kozane/src/test-utils/image-crash-worker.ts");
const loader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const bytes = '<svg xmlns="http://www.w3.org/2000/svg"/>';
let root: string;
let client: Client;
const images = () => join(root, ".kozane", "assets", "images");
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kozane-image-crash-"));
  client = createClient({ url: `file:${join(root, "db.sqlite")}` });
  const db = brandDb(drizzle(client, { schema }));
  await migrateNodeDatabase(db, { migrationsFolder: resolve("drizzle") });
  await createNamespace({ db, name: "Crash recovery" });
  client.close();
});
afterEach(async () => {
  client.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** Kill only after the worker acknowledges the precise boundary. Never use timing sleeps. */
async function run(operation: string, stop = "", atBoundary?: () => Promise<void>) {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ["--expose-gc", "--import", loader, worker, root, operation, stop],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, KOZANE_MEMORY_MODE: "0" },
      },
    );
    let output = "";
    let reached = false;
    let complete = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out during ${operation} at ${stop}\n${output}`));
    }, 15000);
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      output += chunk;
    });
    child.on("message", (message: { boundary?: string; complete?: boolean }) => {
      if (stop && message.boundary === stop) {
        reached = true;
        Promise.resolve()
          .then(atBoundary)
          .then(
            () => child.kill("SIGKILL"),
            (error) => {
              child.kill("SIGKILL");
              reject(error);
            },
          );
      }
      if (message.complete) complete = true;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (stop ? reached && signal === "SIGKILL" : complete && code === 0) resolveRun();
      else
        reject(new Error(`Unexpected ${operation} exit ${code}/${signal} at ${stop}\n${output}`));
    });
  });
}
async function snapshot() {
  // Every observation opens a new connection to the committed state.
  client = createClient({ url: `file:${join(root, "db.sqlite")}` });
  try {
    const uploads = (
      await client.execute("SELECT * FROM local_image_upload ORDER BY filename")
    ).rows.map((row) => ({ ...row }));
    const cards = (await client.execute("SELECT id,content FROM card ORDER BY id")).rows.map(
      (row) => ({ ...row }),
    );
    expect((await client.execute("PRAGMA integrity_check")).rows[0].integrity_check).toBe("ok");
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    return { uploads, cards };
  } finally {
    client.close();
  }
}
async function contents(path: string) {
  return fs.readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

it.each([
  ["reservation-committed", "pending", false, false],
  ["before-file", "pending", false, false],
  ["temporary-created", "pending", false, true],
  ["temporary-written", "pending", false, true],
  ["temporary-synced", "pending", false, true],
  ["linked", "pending", true, true],
  ["temporary-unlinked", "pending", true, false],
  ...(process.platform === "win32" ? [] : [["images-synced", "pending", true, false] as const]),
  ["installed-committed", "installed", true, false],
] as const)(
  "preserves upload evidence after process death at %s",
  async (stop, state, published, temporary) => {
    await run("upload", stop);
    const before = await snapshot();
    expect(before.cards).toEqual([]);
    expect(before.uploads).toHaveLength(1);
    expect(before.uploads[0]).toMatchObject({ state, error: null, completed_at: null });
    const name = String(before.uploads[0].filename);
    const live = join(images(), name);
    const pending = join(images(), `.upload-${name}`);
    const temporaryBytes = stop === "temporary-created" ? "" : bytes;
    expect(await contents(live)).toBe(published ? bytes : null);
    expect(await contents(pending)).toBe(temporary ? temporaryBytes : null);
    if (stop === "reservation-committed")
      await expect(fs.lstat(join(root, ".kozane"))).rejects.toMatchObject({ code: "ENOENT" });
    const queue = join(images(), ".pending-delete");
    await fs.mkdir(queue, { recursive: true });
    await fs.writeFile(join(queue, name), "");
    await run("maintenance");
    expect(await snapshot()).toEqual(before);
    expect(await contents(live)).toBe(published ? bytes : null);
    expect(await contents(pending)).toBe(temporary ? temporaryBytes : null);
    expect(await contents(join(queue, name))).toBe("");
    if (published && !temporary) {
      await run("recover");
      const recovered = await snapshot();
      expect(recovered.uploads[0].state).toBe("installed");
      expect(await contents(live)).toBe(bytes);
      await run("card");
      expect((await snapshot()).uploads[0].state).toBe("completed");
    }
  },
  30000,
);

it.each(["card-before-commit", "card-committed"])(
  "preserves atomic card handoff after process death at %s",
  async (stop) => {
    await run("upload");
    await run("card", stop);
    const before = await snapshot();
    const committed = stop === "card-committed";
    expect(before.cards).toHaveLength(committed ? 1 : 0);
    expect(before.uploads[0].state).toBe(committed ? "completed" : "installed");
    expect(before.uploads[0].completed_at === null).toBe(!committed);
    const path = join(images(), String(before.uploads[0].filename));
    const queue = join(images(), ".pending-delete");
    await fs.mkdir(queue, { recursive: true });
    await fs.writeFile(join(queue, String(before.uploads[0].filename)), "");
    await run("maintenance");
    expect(await snapshot()).toEqual(before);
    expect(await contents(path)).toBe(bytes);
    expect(await contents(join(queue, String(before.uploads[0].filename)))).toBe("");
  },
  30000,
);

it.each(["upload", "card"])(
  "refuses cleanup from another process before killing an active %s writer",
  async (operation) => {
    if (operation === "card") await run("upload");
    const stop = operation === "upload" ? "linked" : "card-before-commit";
    await run(operation, stop, async () => {
      const before = await snapshot();
      expect(before.cards).toEqual([]);
      const name = String(before.uploads[0].filename);
      const queue = join(images(), ".pending-delete");
      await fs.mkdir(queue, { recursive: true });
      await fs.writeFile(join(queue, name), "");
      await run("contending-cleanup");
      expect(await snapshot()).toEqual(before);
      expect(await contents(join(images(), name))).toBe(bytes);
      expect(await contents(join(queue, name))).toBe("");
    });
    const before = await snapshot();
    expect(before.cards).toEqual([]);
    expect(before.uploads[0].state).toBe(operation === "upload" ? "pending" : "installed");
    await run("maintenance");
    expect(await snapshot()).toEqual(before);
    const name = String(before.uploads[0].filename);
    expect(await contents(join(images(), name))).toBe(bytes);
    expect(await contents(join(images(), ".pending-delete", name))).toBe("");
  },
  30000,
);

it.each([
  "archive-file-synced",
  "linked",
  ...(process.platform === "win32" ? [] : ["archive-synced"]),
  "live-unlinked",
  "archive-complete",
])(
  "resumes exclusive archiving after process death at %s",
  async (stop) => {
    const name = "00000000-0000-4000-8000-000000000001.svg";
    await fs.mkdir(images(), { recursive: true });
    const live = join(images(), name);
    const retained = join(images(), ".retained", name);
    await fs.writeFile(live, bytes);
    await fs.utimes(live, new Date(0), new Date(0));
    const original = await fs.lstat(live, { bigint: true });
    await run("archive", stop);
    expect((await contents(live)) ?? (await contents(retained))).toBe(bytes);
    await run("maintenance");
    expect(await contents(live)).toBe(null);
    expect(await contents(retained)).toBe(bytes);
    const archived = await fs.lstat(retained, { bigint: true });
    expect([archived.dev, archived.ino]).toEqual([original.dev, original.ino]);
    expect((await snapshot()).uploads).toEqual([]);
  },
  30000,
);

it.each([
  "request-file-synced",
  ...(process.platform === "win32" ? [] : ["request-directory-synced"]),
  "delete-committed",
  "live-removed",
  "archive-removed",
  ...(process.platform === "win32" ? [] : ["images-synced", "archive-synced"]),
  "request-removed",
  "deletion-complete",
  ...(process.platform === "win32" ? [] : ["request-ack-synced"]),
])(
  "retries durable deletion after process death at %s",
  async (stop) => {
    await run("upload");
    await run("card");
    const initial = await snapshot();
    const name = String(initial.uploads[0].filename);
    const live = join(images(), name);
    const retained = join(images(), ".retained", name);
    const request = join(images(), ".pending-delete", name);
    await fs.mkdir(join(images(), ".retained"));
    await fs.link(live, retained);
    await run("delete", stop);
    const before = await snapshot();
    const committed = !["request-file-synced", "request-directory-synced"].includes(stop);
    expect(before.cards).toHaveLength(committed ? 0 : 1);
    expect(before.uploads).toEqual(initial.uploads);
    if (!committed) {
      expect(await contents(live)).toBe(bytes);
      expect(await contents(retained)).toBe(bytes);
    }
    expect(await contents(request)).toBe(
      ["request-removed", "request-ack-synced", "deletion-complete"].includes(stop) ? null : "",
    );
    await run("maintenance");
    expect(await snapshot()).toEqual(before);
    expect(await contents(live)).toBe(committed ? null : bytes);
    expect(await contents(retained)).toBe(committed ? null : bytes);
    expect(await contents(request)).toBe(committed ? null : "");
    if (!committed) {
      await run("delete");
      expect((await snapshot()).cards).toEqual([]);
      expect(await contents(request)).toBe(null);
      expect(await contents(live)).toBe(null);
      expect(await contents(retained)).toBe(null);
    }
  },
  30000,
);
