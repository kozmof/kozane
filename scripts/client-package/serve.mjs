import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
const root = resolve("tmp/client-package-harness");
const files = new Map([["/", join(root, "index.html")]]);
for (const name of ["board", "tags", "map"]) files.set(`/${name}.html`, join(root, `${name}.html`));
for (const entry of await readdir(join(root, "assets"), { withFileTypes: true }))
  if (entry.isFile()) files.set(`/assets/${entry.name}`, join(root, "assets", entry.name));
async function addKitAssets(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await addKitAssets(path, prefix + entry.name + "/");
    else if (entry.isFile()) files.set(prefix + entry.name, path);
  }
}
await addKitAssets(join(root, "kit"), "/kit/");
for (const name of ["board", "tags", "map", "editor", "namespaces"])
  files.set(`/kit/${name}/`, join(root, "kit", name, "index.html"));
createServer(async (request, response) => {
  const file = files.get(new URL(request.url, "http://localhost").pathname);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
    };
    response
      .writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" })
      .end(await readFile(file));
  } catch {
    response.writeHead(500).end();
  }
}).listen(4182, "127.0.0.1");
