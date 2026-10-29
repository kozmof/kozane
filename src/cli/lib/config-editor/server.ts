import http from "node:http";
import { type EditorContext, handleConfigRequest } from "./handler.js";

/** A config file is a few kilobytes. Anything far larger is not a real save. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Serve the config page and its API through {@link handleConfigRequest}. */
export function createConfigEditorServer(ctx: EditorContext): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Request body is too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      let response;
      try {
        response = handleConfigRequest(ctx, {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      } catch (error) {
        console.error("Config page error:", error);
        response = {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ error: (error as Error).message }),
        };
      }
      res.writeHead(response.status, response.headers);
      res.end(req.method === "HEAD" ? undefined : response.body);
    });
  });
}
