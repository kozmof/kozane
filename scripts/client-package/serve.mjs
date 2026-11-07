import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
const root = resolve("tmp/client-package-harness");
const files = new Map([["/", join(root, "index.html")]]);
for (const entry of await readdir(join(root, "assets"), { withFileTypes: true }))
  if (entry.isFile()) files.set(`/assets/${entry.name}`, join(root, "assets", entry.name));
createServer(async (request, response) => {
  const file = files.get(request.url);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    response
      .writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" })
      .end(await readFile(file));
  } catch {
    response.writeHead(500).end();
  }
}).listen(4182, "127.0.0.1");
