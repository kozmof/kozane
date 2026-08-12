import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_STATE_FILE } from "./lib/server/runtime-state";

// A workspace already claimed by another process is a permanent condition for this server,
// and `hooks.server` remembers it in module state. Kept in its own file so that state does
// not leak into the request tests next door.
const state = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("./db/internal/config", () => ({ getWorkspaceRoot: () => state.root }));
vi.mock("./db/client", () => ({ getDb: vi.fn(async () => ({ ready: true })) }));

/**
 * pid 1 always exists and is never this process. A signal-0 probe of it fails with EPERM
 * for an unprivileged user, which `activeServerProcess` reads as "running" — exactly the
 * answer a genuinely live server would give.
 */
const FOREIGN_LIVE_PID = 1;

function claimedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-claimed-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(
    join(root, ".kozane", SERVER_STATE_FILE),
    JSON.stringify({ pid: FOREIGN_LIVE_PID, startedAt: new Date().toISOString() }) + "\n",
  );
  return root;
}

function event(url = "http://localhost/") {
  return {
    url: new URL(url),
    request: new Request(url),
    locals: {},
    cookies: { get: () => undefined, set: () => undefined, serialize: () => "" },
    getClientAddress: () => "127.0.0.1",
  };
}

describe("workspace already served by another process", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.HOST = "127.0.0.1";
    delete process.env.KOZANE_SSG;
    state.root = claimedWorkspace();
  });

  it("answers 503 naming the process that holds the workspace", async () => {
    const { handle } = await import("./hooks.server");
    const resolve = vi.fn();

    const response = await handle({ event: event() as never, resolve: resolve as never });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain(
      `already served by process ${FOREIGN_LIVE_PID}`,
    );
    // The request never reaches the app, so nothing touches the other server's database.
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps answering 503 without racing the lock file again", async () => {
    const { handle } = await import("./hooks.server");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let i = 0; i < 3; i += 1) {
      const response = await handle({ event: event() as never, resolve: vi.fn() as never });
      expect(response.status).toBe(503);
    }

    // Logged once, not once per request: a permanent condition reported over and over reads
    // as an intermittent fault.
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("carries the security headers every other response gets", async () => {
    const { handle } = await import("./hooks.server");
    const response = await handle({ event: event() as never, resolve: vi.fn() as never });

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
