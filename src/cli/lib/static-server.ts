import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

// Serves a `kozane ssg` export the way a static host (e.g. GitHub Pages) does:
// directory requests resolve to index.html, extensionless directory paths get a
// trailing-slash redirect, and unknown paths fall back to 404.html.

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export type Resolution =
  | { kind: "redirect"; location: string }
  | { kind: "file"; path: string; contentType: string }
  | { kind: "notFound" };

export async function resolveRequest(root: string, rawUrl: string): Promise<Resolution> {
  const pathname = rawUrl.split("?")[0].split("#")[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "notFound" };
  }

  // Strip leading slashes and any traversal segments so the request cannot
  // escape the served root.
  const rel = normalize(decoded).replace(/^([/\\]|\.\.([/\\]|$))+/, "");
  const target = rel === "" ? root : join(root, rel);
  if (target !== root && !target.startsWith(root + sep)) return { kind: "notFound" };

  let info;
  try {
    info = await stat(target);
  } catch {
    return { kind: "notFound" };
  }

  if (info.isDirectory()) {
    if (!decoded.endsWith("/")) return { kind: "redirect", location: pathname + "/" };
    const index = join(target, "index.html");
    try {
      if ((await stat(index)).isFile()) {
        return { kind: "file", path: index, contentType: contentTypeFor(index) };
      }
    } catch {
      // No index.html in this directory.
    }
    return { kind: "notFound" };
  }

  return { kind: "file", path: target, contentType: contentTypeFor(target) };
}

// A leading base path (e.g. "/kozane") lets the server preview a site that was
// built with `--base`, whose client router expects to live under that prefix.
function normalizeBase(base: string): string {
  if (!base || base === "/") return "";
  const withLead = base.startsWith("/") ? base : "/" + base;
  return withLead.endsWith("/") ? withLead.slice(0, -1) : withLead;
}

export function createStaticServer(root: string, base = ""): http.Server {
  const mount = normalizeBase(base);

  return http.createServer(async (req, res) => {
    let url = req.url ?? "/";

    if (mount) {
      const pathOnly = url.split("?")[0];
      if (pathOnly === "/" || pathOnly === mount) {
        res.writeHead(302, { location: mount + "/" });
        res.end();
        return;
      }
      if (pathOnly.startsWith(mount + "/")) {
        url = url.slice(mount.length);
      } else {
        await sendNotFound(root, res);
        return;
      }
    }

    const resolution = await resolveRequest(root, url);

    if (resolution.kind === "redirect") {
      res.writeHead(301, { location: mount + resolution.location });
      res.end();
      return;
    }
    if (resolution.kind === "notFound") {
      await sendNotFound(root, res);
      return;
    }
    try {
      const body = await readFile(resolution.path);
      res.writeHead(200, { "content-type": resolution.contentType });
      res.end(body);
    } catch {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal error");
    }
  });
}

async function sendNotFound(root: string, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readFile(join(root, "404.html"));
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}
