import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyConnectionPragmas, BUSY_TIMEOUT_MS } from "./pragmas.js";

const tempRoots: string[] = [];

function tempDbUrl(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-pragmas-test-"));
  tempRoots.push(root);
  return `file:${join(root, "kozane.db")}`;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function pragma(url: string, name: string): Promise<unknown> {
  const client = createClient({ url });
  try {
    const result = await client.execute(`PRAGMA ${name}`);
    return result.rows[0]?.[name];
  } finally {
    client.close();
  }
}

describe("applyConnectionPragmas", () => {
  it("puts a file-backed database into WAL, and leaves it there for the next connection", async () => {
    const url = tempDbUrl();
    const client = createClient({ url });
    try {
      await applyConnectionPragmas(client, url);
      // Create something, so the mode is written to a database with a header to hold it.
      await client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    } finally {
      client.close();
    }

    // The mode is a property of the file: a connection that never asks for WAL still gets
    // it, which is what lets the read-only clients elsewhere stay as they are.
    expect(await pragma(url, "journal_mode")).toBe("wal");
  });

  it("enforces foreign keys on the connection it is given", async () => {
    const url = tempDbUrl();
    const client = createClient({ url });
    try {
      await applyConnectionPragmas(client, url);
      expect((await client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys).toBe(1);
      expect((await client.execute("PRAGMA busy_timeout")).rows[0]?.timeout).toBe(BUSY_TIMEOUT_MS);
    } finally {
      client.close();
    }
  });

  it("leaves an in-memory database in the mode it has, having no file to log beside", async () => {
    const url = ":memory:";
    const client = createClient({ url });
    try {
      await applyConnectionPragmas(client, url);
      expect((await client.execute("PRAGMA journal_mode")).rows[0]?.journal_mode).not.toBe("wal");
      // The two that are about the connection still apply.
      expect((await client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys).toBe(1);
    } finally {
      client.close();
    }
  });
});
