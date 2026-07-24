import { describe, expect, it, vi } from "vitest";
import { GET } from "./+server";

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
    await expect(GET({ locals: { db: { run } } } as never)).rejects.toBe(failure);
  });
});
