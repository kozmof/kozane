import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/main.js", ["main.js", "text/javascript"]],
  ["/worker.js", ["worker.js", "text/javascript"]],
  ["/sqlite3.wasm", ["sqlite3.wasm", "application/wasm"]],
  ["/sample.db", ["sample.db", "application/octet-stream"]],
  ["/manifest.json", ["manifest.json", "application/json"]],
]);
createServer(async (request, response) => {
  const file = files.get(request.url);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    response
      .writeHead(200, { "Content-Type": file[1] })
      .end(await readFile(`tmp/restoration-harness/${file[0]}`));
  } catch {
    response.writeHead(500).end();
  }
}).listen(4181, "127.0.0.1");
