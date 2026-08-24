import { describe, expect, it, vi } from "vitest";
import { GET } from "./+server.js";

describe("health endpoint", () => {
  it("checks the database before reporting readiness", async () => {
    const run = vi.fn(async () => undefined);
    const response = await GET({ locals: { db: { run } } } as never);
    expect(run).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    const health = await response.json();
    expect(health).toEqual({
      status: "ok",
      cpuUsage: expect.any(Number),
      memoryUsage: expect.any(Number),
    });
    expect(health.cpuUsage).toBeGreaterThanOrEqual(0);
    expect(health.cpuUsage).toBeLessThanOrEqual(100);
    expect(health.memoryUsage).toBeGreaterThanOrEqual(0);
    expect(health.memoryUsage).toBeLessThanOrEqual(100);
  });

  it("does not report healthy when the database check fails", async () => {
    const failure = new Error("database unavailable");
    const run = vi.fn(async () => {
      throw failure;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Answered rather than thrown: a probe reads `status` out of the body, which a
    // rendered error page would not carry.
    const response = await GET({ locals: { db: { run } } } as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      error: "database is not answering queries",
      cpuUsage: expect.any(Number),
      memoryUsage: expect.any(Number),
    });
    // The cause still reaches the log, which is the only place it is recorded now.
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Health check failed"), failure);
    error.mockRestore();
  });
});
