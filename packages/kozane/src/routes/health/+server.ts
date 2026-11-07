import { sql } from "drizzle-orm";
import { json } from "@sveltejs/kit";
import { availableParallelism, freemem, totalmem } from "node:os";
import { cpuUsage, uptime } from "node:process";
import type { RequestHandler } from "./$types";

function percentage(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

function getCpuUsageRate(): number {
  const usage = cpuUsage();
  const capacity = uptime() * 1_000_000 * availableParallelism();
  return percentage(((usage.user + usage.system) / capacity) * 100);
}

function getMemoryUsageRate(): number {
  const total = totalmem();
  return percentage(((total - freemem()) / total) * 100);
}

/**
 * Report readiness with a status field on both success and failure. Return 503 for an
 * unavailable database so probes receive structured diagnostics rather than a rendered error
 * page.
 */
export const GET: RequestHandler = async ({ locals }) => {
  try {
    await locals.db.run(sql.raw("select 1"));
  } catch (e) {
    console.error("[kozane] Health check failed:", e);
    return json(
      {
        status: "error",
        error: "database is not answering queries",
        cpuUsage: getCpuUsageRate(),
        memoryUsage: getMemoryUsageRate(),
      },
      { status: 503 },
    );
  }
  return json({
    status: "ok",
    cpuUsage: getCpuUsageRate(),
    memoryUsage: getMemoryUsageRate(),
  });
};
