#!/usr/bin/env node

/**
 * Kozane's HTTP server entry. It binds to `DEFAULT_SERVER_HOST` unless `HOST` is set.
 *
 * This entry calls `listen` directly so the default address does not depend on SvelteKit's
 * module loading order. It imports the application middleware from `build/handler.js` and
 * supplies timeouts, a 404 fallback, and graceful shutdown.
 *
 * The file stays in JavaScript because `build/handler.js` is generated without TypeScript
 * declarations.
 *
 * An explicit `BODY_SIZE_LIMIT` takes precedence. Otherwise, the limit is derived from
 * `ui.contentMax` before the handler loads.
 *
 * `kozane open` starts this entry with `HOST` and `PORT` . Systemd socket activation and
 * `SOCKET_PATH` are not supported here.
 */

import http from "node:http";
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "../dist/lib/constants.js";
import { canonicalLoopbackOrigin } from "../dist/lib/server/security.js";
import { bodySizeLimitFor, contentMax } from "../dist/lib/server/content-limit.js";

/**
 * Set `BODY_SIZE_LIMIT` before importing the handler, which reads it at module scope.
 * `bodySizeLimitFor` allows room for a card up to the workspace's `ui.contentMax` .
 *
 * Keep an explicit environment setting. If the workspace configuration cannot be read, leave
 * the adapter's default in place and let the request hooks report the configuration error.
 */
if (process.env.BODY_SIZE_LIMIT === undefined) {
  try {
    process.env.BODY_SIZE_LIMIT = String(bodySizeLimitFor(contentMax()));
  } catch {
    // No workspace to read, or an unreadable one. `hooks.server.ts` is what says so.
  }
}

const { handler } = await import("../build/handler.js");

/**
 * Read a non-negative integer from the environment, or return `fallback` . Reject invalid text
 * so a mistyped timeout cannot silently become `NaN` .
 */
function seconds(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid value for environment variable ${name}: ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 10);
}

// Write the resolved host back to the environment so the API-key and TLS checks in
// `lib/server/security.ts` use the address this server binds to.
const host = process.env.HOST ?? DEFAULT_SERVER_HOST;
const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
process.env.HOST = host;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid PORT: ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Canonicalize loopback origins before the handler runs SvelteKit's CSRF check.
  // `hooks.server.ts` runs too late to do this. `canonicalLoopbackOrigin` decides which origins
  // qualify.
  const origin = canonicalLoopbackOrigin(req.headers.origin, process.env.ORIGIN, req.headers.host);
  if (origin) req.headers.origin = origin;

  // End unmatched requests with a 404 so their sockets do not wait for a timeout.
  handler(req, res, () => {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("Not found");
  });
});

const keepAlive = seconds("KEEP_ALIVE_TIMEOUT");
if (keepAlive !== undefined) server.keepAliveTimeout = keepAlive * 1000;
const headers = seconds("HEADERS_TIMEOUT");
if (headers !== undefined) server.headersTimeout = headers * 1000;

const shutdownTimeout = seconds("SHUTDOWN_TIMEOUT", 30);

let shutdownTimer;

/**
 * Stop accepting requests, close idle connections, and let active requests finish. Force
 * shutdown after the timeout so a stuck request cannot hold the workspace reservation
 * indefinitely.
 */
function shutdown(reason) {
  if (shutdownTimer) return;
  server.closeIdleConnections();
  server.close((error) => {
    if (error) return; // already closed
    clearTimeout(shutdownTimer);
    process.emit("sveltekit:shutdown", reason);
    // Exiting runs the hook that releases the workspace reservation.
    process.exit(0);
  });
  shutdownTimer = setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, shutdownTimeout * 1000);
}

// During shutdown, close each connection when it becomes idle.
server.on("request", (req) => {
  req.on("close", () => {
    if (shutdownTimer) server.closeIdleConnections();
  });
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen({ host, port }, () => {
  const address = server.address();
  const shown = typeof address === "object" && address ? address.address : host;
  const bracketed = shown.includes(":") ? `[${shown}]` : shown;
  // Report the bound socket address for `scripts/smoke-production.mjs` to verify.
  console.log(
    `Listening on http://${bracketed}:${typeof address === "object" && address ? address.port : port}`,
  );
});
