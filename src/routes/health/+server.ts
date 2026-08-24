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
 * Readiness, as a probe reads it.
 *
 * A database that will not answer is reported rather than thrown. Left to throw, the one
 * endpoint whose job is to say whether the server is healthy answers with a rendered error
 * page — a probe then has only the status code to go on, and the body says nothing about
 * what failed. 503 rather than 500 because the condition is the workspace's and clears
 * without a restart, which is the same distinction `hooks.server.ts` draws for the key
 * file.
 *
 * `status` is the field to alert on, and it is present either way.
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
