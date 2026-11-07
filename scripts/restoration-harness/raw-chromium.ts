import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** Minimal CDP pipe transport. No Playwright page lifecycle or worker debugger attachment. */
export class PipeCDP {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private buffer = "";
  private failure?: Error;
  readonly events: { method: string; params: any; sessionId?: string }[] = [];
  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\0")) >= 0) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(frame));
        } catch {
          this.fail(new Error("Invalid Chromium CDP frame"));
        }
      }
    });
    output.on("error", (error) => this.fail(error));
    output.on("end", () => this.fail(new Error("Chromium CDP pipe closed")));
    input.on("error", (error) => this.fail(error));
  }
  private receive(message: any): void {
    if (message.id === undefined) {
      if (this.events.length === 100) this.events.shift();
      this.events.push(message);
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 10_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chromium CDP deadline exceeded: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export async function openRawChromium(executable: string) {
  const profile = await mkdtemp(join(tmpdir(), "kozane-bfcache-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  const cdp = new PipeCDP(child.stdio[3] as Writable, child.stdio[4] as Readable);
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-32_768);
  });
  child.on("error", (error) => cdp.fail(error));
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      cdp.fail(new Error(`Chromium exited: ${stderr}`));
      resolve();
    });
  });
  return {
    cdp,
    async close() {
      cdp.fail(new Error("Chromium controller closed"));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        await rm(profile, { recursive: true, force: true });
      }
    },
  };
}

/** Evaluate once. Mutations are never retried after an uncertain reply. */
export async function evaluateOnce(
  cdp: PipeCDP,
  sessionId: string,
  expression: string,
): Promise<any> {
  const reply = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
/** Poll read-only predicates without depending on replayed page lifecycle events. */
export async function evaluateUntil(
  cdp: PipeCDP,
  sessionId: string,
  expression: string,
): Promise<any> {
  const end = performance.now() + 10_000;
  while (performance.now() < end) {
    try {
      const value = await evaluateOnce(cdp, sessionId, expression);
      if (value) return value;
    } catch (error) {
      // Cross-document navigation briefly has no default execution context.
      if (
        !(error instanceof Error) ||
        !/Cannot find context|Cannot find default execution context|Execution context was destroyed/.test(
          error.message,
        )
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chromium readiness deadline exceeded: ${expression}`);
}
