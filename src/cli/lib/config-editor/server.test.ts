import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER, configFilePath } from "./handler.js";
import { MAX_BODY_BYTES, createConfigEditorServer } from "./server.js";

const HOST = "127.0.0.1:40000";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-config-server-"));
  mkdirSync(join(root, ".kozane"));
  mkdirSync(join(root, "page"));
  writeFileSync(join(root, "page", "index.html"), "<p>page</p>");
  writeFileSync(
    configFilePath(root),
    JSON.stringify({ name: "demo", taskspace: { defaultDir: ".", searchRoots: ["."] } }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Captured = { status: number; headers: Record<string, string>; body: string };

/** Feed one request to the server's handler without opening a socket. */
function dispatch(method: string, url: string, headers: Record<string, string>, body = "") {
  const server = createConfigEditorServer({
    root,
    token: "t",
    allowedHosts: new Set([HOST]),
    assetsDir: join(root, "page"),
  });
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method,
    url,
    headers,
  });
  return new Promise<Captured>((resolve) => {
    const captured: Captured = { status: 0, headers: {}, body: "" };
    const res = {
      writeHead(status: number, responseHeaders: Record<string, string> = {}) {
        captured.status = status;
        captured.headers = responseHeaders;
      },
      end(chunk?: string | Buffer) {
        captured.body = chunk === undefined ? "" : String(chunk);
        resolve(captured);
      },
    };
    server.emit("request", req, res);
  });
}

describe("createConfigEditorServer", () => {
  it("passes requests through to the handler", async () => {
    const response = await dispatch("GET", "/api/config", { host: HOST, [TOKEN_HEADER]: "t" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).values.name).toBe("demo");
  });

  it("sends no body for HEAD", async () => {
    const response = await dispatch("HEAD", "/", { host: HOST });
    expect(response.status).toBe(200);
    expect(response.body).toBe("");
  });

  it("refuses an oversized body", async () => {
    const response = await dispatch(
      "PUT",
      "/api/config",
      { host: HOST, [TOKEN_HEADER]: "t", "content-type": "application/json" },
      "x".repeat(MAX_BODY_BYTES + 1),
    );
    expect(response.status).toBe(413);
  });
});
