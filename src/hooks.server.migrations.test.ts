import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./cli/lib/db";

// Isolate the module's cached state for each migration-hook suite.
const state = vi.hoisted(() => ({ root: null as string | null, dbUrl: "" }));
vi.mock("./db/internal/config", () => ({
  getWorkspaceRoot: () => state.root,
  getDBURL: () => state.dbUrl,
}));
vi.mock("./db/client", () => ({ getDb: vi.fn(async () => ({ ready: true })) }));

/** Workspace directory and expected database path, whether or not the file exists. */
function workspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "kozane-migrations-"));
  mkdirSync(join(root, ".kozane"));
  return { root, dbPath: join(root, ".kozane", "kozane.db") };
}

function event(url = "http://localhost/") {
  return {
    url: new URL(url),
    request: new Request(url),
    locals: {} as Record<string, unknown>,
    cookies: { get: () => undefined, set: () => undefined, serialize: () => "" },
    getClientAddress: () => "127.0.0.1",
  };
}

describe("workspace database behind this version", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.HOST = "127.0.0.1";
    delete process.env.KOZANE_SSG;
  });

  it("serves a workspace whose migrations are all applied", async () => {
    const { root, dbPath } = workspace();
    state.root = root;
    state.dbUrl = `file:${dbPath}`;
    await runMigrations(state.dbUrl);

    const { handle } = await import("./hooks.server");
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await handle({ event: event() as never, resolve: resolve as never });

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("answers 503 naming the fix when the database has never been migrated", async () => {
    const { root, dbPath } = workspace();
    state.root = root;
    state.dbUrl = `file:${dbPath}`;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { handle } = await import("./hooks.server");
    const resolve = vi.fn();
    const response = await handle({ event: event() as never, resolve: resolve as never });

    // Distinguish a missing database from pending migrations.
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain("kozane init");
    // Reject the request before application queries reach an incompatible schema.
    expect(resolve).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("names the migration command for a database that exists but is behind", async () => {
    const { root, dbPath } = workspace();
    state.root = root;
    state.dbUrl = `file:${dbPath}`;
    // Drop the migration table from an existing database to exercise pending status.
    await runMigrations(state.dbUrl);
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: state.dbUrl });
    await client.execute("DELETE FROM __drizzle_migrations");
    client.close();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { handle } = await import("./hooks.server");
    const response = await handle({ event: event() as never, resolve: vi.fn() as never });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain("kozane db migrate");
    error.mockRestore();
  });

  it("logs the condition once rather than once per request", async () => {
    const { root, dbPath } = workspace();
    state.root = root;
    state.dbUrl = `file:${dbPath}`;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { handle } = await import("./hooks.server");
    for (let i = 0; i < 3; i += 1) {
      const response = await handle({ event: event() as never, resolve: vi.fn() as never });
      expect(response.status).toBe(503);
    }

    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("carries the security headers every other response gets", async () => {
    const { root, dbPath } = workspace();
    state.root = root;
    state.dbUrl = `file:${dbPath}`;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { handle } = await import("./hooks.server");
    const response = await handle({ event: event() as never, resolve: vi.fn() as never });

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    error.mockRestore();
  });

  it("exempts an in-memory database, which is migrated by the act of opening it", async () => {
    const { root } = workspace();
    state.root = root;
    // A second connection to `:memory:` is a different, empty database, so asking it what
    // it has applied would report every migration pending against a session that is current.
    state.dbUrl = ":memory:";

    const { handle } = await import("./hooks.server");
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await handle({ event: event() as never, resolve: resolve as never });

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("does not run at all during a static export, which has its own check", async () => {
    const { root, dbPath } = workspace();
    state.root = root;
    state.dbUrl = `file:${dbPath}`;
    process.env.KOZANE_SSG = "1";

    const { handle } = await import("./hooks.server");
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await handle({ event: event() as never, resolve: resolve as never });

    // `kozane net ssg generate` runs `requireCurrentMigrations` before it prerenders a page,
    // so the gate here would only re-answer a question already settled.
    expect(response.status).toBe(200);
    delete process.env.KOZANE_SSG;
  });
});
