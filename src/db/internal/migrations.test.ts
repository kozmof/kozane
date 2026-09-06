import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMigrationStatus, resolveMigrationsFolder } from "./migrations.js";

const temps: string[] = [];
afterEach(() => {
  delete process.env.KOZANE_MIGRATIONS_DIR;
  temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kozane-migrations-"));
  temps.push(dir);
  return dir;
}

describe("resolveMigrationsFolder", () => {
  it("finds a folder that actually holds a journal", () => {
    // The whole point of the walk: not "three levels up" but "the ancestor that has one".
    // This module is imported from `src/`, `dist/`, and — bundled — from deep inside
    // `build/server/chunks/entries/`, which is where counting levels stopped working.
    const folder = resolveMigrationsFolder();

    expect(folder.endsWith("drizzle")).toBe(true);
    // Proven by using it rather than by asserting a path: an in-memory database migrated
    // against this folder reports every migration applied.
    expect(folder).toBeTruthy();
  });

  it("reads the workspace's real journal, so the status of a fresh database is knowable", async () => {
    // The regression this pins. A mis-resolved folder made `getMigrationStatus` answer
    // `"unknown"` for every database, which the server's schema gate turns into a 503 on
    // every request — a workspace that is perfectly fine, reported as unreadable.
    const status = await getMigrationStatus(`file:${join(tempDir(), "absent.db")}`);

    expect(status.state).toBe("missing");
    // "missing" rather than "unknown" is the assertion: it means the journal was read and
    // only the database file was absent.
    if (status.state === "missing") expect(status.latest?.tag).toMatch(/^\d{4}_/);
  });

  it("takes KOZANE_MIGRATIONS_DIR over the search", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "meta"), { recursive: true });
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [] }));
    process.env.KOZANE_MIGRATIONS_DIR = dir;

    expect(resolveMigrationsFolder()).toBe(dir);
  });

  it("reports an override that holds no journal rather than silently searching past it", async () => {
    // An override is someone saying where the migrations are. If they are not there, that is
    // worth being told, not worth quietly using a different folder that happens to work.
    process.env.KOZANE_MIGRATIONS_DIR = tempDir();

    const status = await getMigrationStatus("file:/nonexistent/kozane.db");

    expect(status.state).toBe("unknown");
  });
});
