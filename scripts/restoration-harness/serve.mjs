import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/away", ["away.html", "text/html"]],
  ["/main.js", ["main.js", "text/javascript"]],
  ["/worker.js", ["worker.js", "text/javascript"]],
  ["/sqlite3.wasm", ["sqlite3.wasm", "application/wasm"]],
  ["/sample.db", ["sample.db", "application/octet-stream"]],
  ["/corpus.json", ["corpus.json", "application/json"]],
  ["/manifest.json", ["manifest.json", "application/json"]],
]);
const corpus = JSON.parse(await readFile("tmp/restoration-harness/corpus.json", "utf8"));
for (const fixture of corpus.fixtures) {
  if (!/^\/corpus\/[a-z0-9][a-z0-9.-]+\/[a-z0-9][a-z0-9.-]*\.sqlite3$/.test(fixture.url))
    throw new Error("Invalid browser corpus path");
  files.set(fixture.url, [fixture.url.slice(1), "application/octet-stream"]);
}
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
