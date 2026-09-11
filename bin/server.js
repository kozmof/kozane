#!/usr/bin/env node

/**
 * Kozane's HTTP server entry, in place of adapter-node's `build/index.js`.
 *
 * The reason this file exists is one line in the file it replaces:
 *
 *     const host = env('HOST', '0.0.0.0');
 *
 * A workspace is a person's notes on their own machine, so binding every interface is the
 * wrong default for this application whatever it is for the adapter. `src/hooks.server.ts`
 * used to override it by assigning `process.env.HOST` at module scope and winning a race:
 * `build/index.js` statically imports the handler chunk, that chunk ends in a top-level
 * `await server.init(...)`, and `init()` reaches hooks through a dynamic import — so hooks
 * evaluated before the entry's own body read HOST. It worked. It also depended on two
 * SvelteKit internals staying true, and the failure mode if either changed was a server
 * quietly listening on every interface, with no error to notice.
 *
 * So Kozane calls `listen` itself. The address comes from {@link DEFAULT_SERVER_HOST}, a
 * constant in this repository, and adapter-node's default is never consulted because the
 * module that holds it is never run. There is no ordering left to get wrong.
 *
 * `build/handler.js` is adapter-node's supported embedding entry and is what makes this
 * cheap: the whole SvelteKit application arrives as one middleware, and what is written out
 * below is only the part `index.js` wraps around it — timeouts, the listen call, and a
 * graceful shutdown.
 *
 * Plain JavaScript rather than TypeScript compiled into `dist/`, because it imports
 * `build/handler.js`, which is a build artifact with no declarations and which does not
 * exist when `tsc` runs.
 *
 * ## What is deliberately not ported
 *
 * `BODY_SIZE_LIMIT` is ported in the sense that matters: it is still the adapter reading it,
 * and still overridable, but a workspace that has not set one gets a ceiling sized from
 * `ui.contentMax` instead of the adapter's 512K. See the block below.
 *
 * `index.js` also supports systemd socket activation (`LISTEN_PID`/`LISTEN_FDS`) and
 * `SOCKET_PATH`. Kozane starts its own server on a host and port — `kozane open` spawns
 * this file with HOST and PORT set — and nothing in the CLI, the docs, or the security
 * matrix offers either. Leaving them out is better than carrying an untested reimplementation
 * of them: a half-ported socket activation that mis-parses `LISTEN_FDS` would bind something
 * unexpected, which is the class of bug this file exists to close.
 */

import http from "node:http";
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "../dist/lib/constants.js";
import { canonicalLoopbackOrigin } from "../dist/lib/server/security.js";
import { bodySizeLimitFor, contentMax } from "../dist/lib/server/content-limit.js";

/**
 * The body ceiling has to be in the environment before the handler module is evaluated:
 * adapter-node reads `BODY_SIZE_LIMIT` once, at its own module scope, and its 512K default
 * is smaller than one card of this workspace's `ui.contentMax`. Left at the default, a long
 * card is refused by the transport before any endpoint sees it — see {@link bodySizeLimitFor}.
 *
 * Hence the dynamic import below. This is the ordering hazard the note above describes for
 * HOST, met the other way round: not a race won by loading order, but a write that plainly
 * happens first, with the import that reads it moved after it where that is visible.
 *
 * An explicit setting wins, the way it does for every other variable here. A workspace whose
 * config cannot be read falls back to the adapter's own default rather than failing to start:
 * the request that would need the room is the one that reports the problem.
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
 * A non-negative integer from the environment, or `fallback`. Mirrors adapter-node's
 * `timeout_env`, including refusing a value that is not one rather than coercing it: a
 * mistyped `KEEP_ALIVE_TIMEOUT` should say so, not silently become `NaN` milliseconds.
 */
function seconds(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid value for environment variable ${name}: ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 10);
}

// Resolved here and written back, so that everything downstream reading `process.env.HOST`
// — `remoteBindingRequiresApiKey` and `remoteBindingRequiresTls` in `lib/server/security.ts`
// — sees the address actually bound rather than an absence it has to guess at.
const host = process.env.HOST ?? DEFAULT_SERVER_HOST;
const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
process.env.HOST = host;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid PORT: ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Before the handler, because SvelteKit's CSRF check runs inside it and ahead of
  // `hooks.server.ts`, so there is nowhere further in that a form POST can be rescued. What
  // is rescued, and what is left refused, is `canonicalLoopbackOrigin`'s to decide.
  const origin = canonicalLoopbackOrigin(req.headers.origin, process.env.ORIGIN, req.headers.host);
  if (origin) req.headers.origin = origin;

  // The `next` adapter-node's middleware calls when no route matched. Under `index.js` polka
  // supplies one; here it is this, and it has to exist — without it an unmatched request
  // leaves the socket open until it times out.
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
 * Stop accepting work, let what is in flight finish, then exit.
 *
 * Ported from `index.js` rather than reduced to `server.close()`, and the two lines that
 * look redundant are the ones that matter. `close()` alone waits out every keep-alive
 * connection even when it is carrying no request, so a browser with the board open would
 * hold the process for its full timeout — `closeIdleConnections` before it is what makes
 * `kozane open`'s Ctrl-C feel immediate. The timer is the other end: a request that never
 * finishes must not hold the workspace's reservation for ever.
 */
function shutdown(reason) {
  if (shutdownTimer) return;
  server.closeIdleConnections();
  server.close((error) => {
    if (error) return; // already closed
    clearTimeout(shutdownTimer);
    process.emit("sveltekit:shutdown", reason);
    // `process.once("exit", …)` in hooks.server releases the workspace reservation, and
    // exiting here is what runs it.
    process.exit(0);
  });
  shutdownTimer = setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, shutdownTimeout * 1000);
}

// Once shutting down, retire each connection the moment it falls idle so it cannot pick up
// another request on the way out. `index.js` also counts requests here, to drive the idle
// timeout that belongs to socket activation; with that not ported, the count had no reader.
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
  // Read back off the socket rather than echoing what was asked for, so the line is evidence
  // of where the server actually is. `scripts/smoke-production.mjs` asserts against it.
  console.log(
    `Listening on http://${bracketed}:${typeof address === "object" && address ? address.port : port}`,
  );
});
