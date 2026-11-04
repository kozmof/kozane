import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const allowed = new Map([
  ["/", ["index.html", "text/html"]],
  ["/main.js", ["main.js", "text/javascript"]],
  ["/worker.js", ["worker.js", "text/javascript"]],
  ["/sqlite3.wasm", ["sqlite3.wasm", "application/wasm"]],
]);
createServer(async (request, response) => {
  const asset = allowed.get(request.url);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(`tmp/browser-spike/${asset[0]}`);
    response.writeHead(200, { "Content-Type": asset[1] }).end(bytes);
  } catch {
    response.writeHead(500).end();
  }
}).listen(4179, "127.0.0.1");
