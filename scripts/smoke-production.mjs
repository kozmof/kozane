import { request } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";

const packageRoot = process.env.KOZANE_PACKAGE_ROOT
  ? resolve(process.env.KOZANE_PACKAGE_ROOT)
  : resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "kozane-production-smoke-"));

function cli(...args) {
  const result = spawnSync(process.execPath, [join(packageRoot, "bin", "kozane.js"), ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(
      `kozane ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

async function waitForServer(url, apiKey) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return response;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw lastError ?? new Error("server did not start");
}

/** Whether anything is accepting connections at `host:port`. */
function accepts(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on("error", () => done(false));
    setTimeout(() => {
      socket.destroy();
      done(false);
    }, 2_000);
  });
}

/** A routable address of this machine, or null where it has none (CI without a NIC). */
function externalAddress() {
  return (
    Object.values(networkInterfaces())
      .flat()
      .find((nic) => nic && nic.family === "IPv4" && !nic.internal)?.address ?? null
  );
}

/**
 * Verify that the built server defaults to loopback when `HOST` is absent. Start
 * `bin/server.js` and inspect the listening socket to check the actual binding. The other cases
 * pass `HOST` explicitly.
 */
async function checkLoopbackDefault(port) {
  const child = spawn(process.execPath, [join(packageRoot, "bin", "server.js")], {
    cwd: packageRoot,
    // Copy environment fields explicitly so an inherited `HOST` cannot affect this test.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      DATABASE_URL: `file:${join(workspace, ".kozane", "kozane.db")}`,
      KOZANE_WORKSPACE_ROOT: workspace,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const listening = await new Promise((done, fail) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Listening on")) done(output);
      });
      child.on("exit", (code) => fail(new Error(`server exited with ${code}\n${output}`)));
      setTimeout(() => fail(new Error(`server did not start\n${output}`)), 20_000);
    });

    // The log reports the socket's bound address.
    if (!listening.includes("127.0.0.1")) {
      throw new Error(`server with no HOST did not bind loopback: ${listening.trim()}`);
    }
    if (!(await accepts("127.0.0.1", port))) {
      throw new Error("server with no HOST did not accept a loopback connection");
    }

    const external = externalAddress();
    if (external && (await accepts(external, port))) {
      throw new Error(
        `server with no HOST is reachable on ${external} — the loopback default did not apply before listen`,
      );
    }
    console.log(
      external
        ? `Loopback default holds: bound 127.0.0.1, refused ${external}.`
        : "Loopback default holds: bound 127.0.0.1 (no external interface to probe).",
    );
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
}

let server;
try {
  cli("init");
  cli("namespace", "create", "Smoke namespace");
  cli("api", "key", "generate");

  const { apiKey } = JSON.parse(readFileSync(join(workspace, ".kozane", "api.json"), "utf8"));
  const port = String(20_000 + Math.floor(Math.random() * 20_000));
  const baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(packageRoot, "bin", "server.js")], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: `file:${join(workspace, ".kozane", "kozane.db")}`,
      KOZANE_WORKSPACE_ROOT: workspace,
      HOST: "127.0.0.1",
      PORT: port,
      // Match the loopback `ORIGIN` set by `kozane open` so SvelteKit accepts form POSTs over
      // HTTP.
      ORIGIN: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const health = await waitForServer(`${baseUrl}/health`, apiKey);
  const body = await health.json();
  if (body.status !== "ok") throw new Error("health response was not ready");
  if (health.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error("security headers were missing");
  }

  const page = await fetch(baseUrl, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!page.ok || !(await page.text()).includes("<!doctype html>")) {
    throw new Error(`authenticated application page returned ${page.status}`);
  }
  const csp = page.headers.get("content-security-policy") ?? "";
  if (!csp.includes("script-src 'self'") || csp.includes("script-src 'self' 'unsafe-inline'")) {
    throw new Error("script CSP was not nonce-protected");
  }

  const unauthorized = await fetch(`${baseUrl}/health`);
  if (unauthorized.status !== 401) {
    throw new Error(`unauthenticated health request returned ${unauthorized.status}`);
  }

  // Exercise the create-namespace form through the built server to check loopback origin
  // normalization before SvelteKit's CSRF check. Use `node:http` to control the Host header and
  // model a forwarded request.
  const createNamespace = (origin, host) =>
    new Promise((resolveRequest, rejectRequest) => {
      const req = request(
        baseUrl,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "x-sveltekit-action": "true",
            origin,
            ...(host ? { host } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", rejectRequest);
          res.on("end", () =>
            resolveRequest(new Response(Buffer.concat(chunks), { status: res.statusCode })),
          );
        },
      );
      req.on("error", rejectRequest);
      req.end(new URLSearchParams({ name: `Smoke ${origin}` }).toString());
    });

  // Use `localhost` in the request origin while `ORIGIN` uses `127.0.0.1`.
  const otherSpelling = await createNamespace(`http://localhost:${port}`);
  if (!otherSpelling.ok) {
    throw new Error(
      `create-namespace form from another loopback spelling returned ${otherSpelling.status}`,
    );
  }
  // A local tunnel preserves the browser's Host but changes the destination port.
  const forwardedHost = `localhost:${Number(port) + 1}`;
  const forwarded = await createNamespace(`http://${forwardedHost}`, forwardedHost);
  const forwardedResult = await forwarded.json();
  if (forwarded.status !== 200 || forwardedResult.type !== "success") {
    throw new Error(`forwarded create-namespace form failed: ${JSON.stringify(forwardedResult)}`);
  }
  const mismatched = await createNamespace(`http://localhost:${Number(port) + 2}`, forwardedHost);
  if (mismatched.status !== 403) {
    throw new Error(`cross-site forwarded form returned ${mismatched.status}`);
  }

  // Verify that mismatched origins are still rejected.
  for (const origin of [`http://localhost:${Number(port) + 1}`, "http://attacker.example"]) {
    const foreign = await createNamespace(origin);
    if (foreign.status !== 403) {
      throw new Error(`cross-site form POST from ${origin} returned ${foreign.status}`);
    }
  }

  cli("db", "export");

  // Run this after stopping the server because it needs the same port.
  if (server && !server.killed) server.kill("SIGTERM");
  await new Promise((done) => server.on("exit", done));
  await checkLoopbackDefault(Number(port) + 1);

  console.log(
    "Production smoke test passed: package CLI, database, authenticated server, form origins, export, and loopback default.",
  );
} finally {
  if (server && !server.killed) server.kill("SIGTERM");
  rmSync(workspace, { recursive: true, force: true });
}
