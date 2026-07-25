import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeFor, createStaticServer, resolveRequest } from "./static-server.js";

const root = mkdtempSync(join(tmpdir(), "kozane-static-"));
writeFileSync(join(root, "index.html"), "<h1>home</h1>");
writeFileSync(join(root, "404.html"), "<h1>missing</h1>");
mkdirSync(join(root, "project"));
writeFileSync(join(root, "project", "index.html"), "<h1>project page</h1>");
mkdirSync(join(root, "_app"));
writeFileSync(join(root, "_app", "app.css"), "body{}");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveRequest", () => {
  it("serves index.html for the root", async () => {
    const r = await resolveRequest(root, "/");
    expect(r).toEqual({
      kind: "file",
      path: join(root, "index.html"),
      contentType: expect.any(String),
    });
  });

  it("redirects an extensionless directory to a trailing slash", async () => {
    expect(await resolveRequest(root, "/project")).toEqual({
      kind: "redirect",
      location: "/project/",
    });
  });

  it("serves the directory index once the slash is present", async () => {
    const r = await resolveRequest(root, "/project/");
    expect(r).toMatchObject({ kind: "file", path: join(root, "project", "index.html") });
  });

  it("serves a static asset with a sensible content type", async () => {
    const r = await resolveRequest(root, "/_app/app.css");
    expect(r).toMatchObject({ kind: "file", contentType: "text/css; charset=utf-8" });
  });

  it("reports unknown paths as not found", async () => {
    expect(await resolveRequest(root, "/does-not-exist")).toEqual({ kind: "notFound" });
  });

  it("blocks path traversal outside the root", async () => {
    expect(await resolveRequest(root, "/../../etc/passwd")).toEqual({ kind: "notFound" });
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("a.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("createStaticServer", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createStaticServer(root);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("serves the home page", async () => {
    const res = await fetch(origin + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("home");
  });

  it("redirects /project to /project/ then serves the page", async () => {
    const redirect = await fetch(origin + "/project", { redirect: "manual" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/project/");

    const followed = await fetch(origin + "/project/");
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain("project page");
  });

  it("returns the 404.html fallback for unknown paths", async () => {
    const res = await fetch(origin + "/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("missing");
  });
});

describe("createStaticServer with a base path", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createStaticServer(root, "/kozane");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("redirects the root to the base path", async () => {
    const res = await fetch(origin + "/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/kozane/");
  });

  it("serves content mounted under the base path", async () => {
    const res = await fetch(origin + "/kozane/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("home");
  });

  it("404s requests outside the base path", async () => {
    const res = await fetch(origin + "/other/");
    expect(res.status).toBe(404);
  });
});
