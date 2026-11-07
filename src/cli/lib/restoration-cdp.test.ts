import { afterEach, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { PipeCDP, evaluateUntil } from "../../../scripts/restoration-harness/raw-chromium";
afterEach(() => vi.useRealTimers());
function fixture() {
  const input = new PassThrough(),
    output = new PassThrough();
  const cdp = new PipeCDP(input, output);
  return { cdp, input, output };
}
it("matches out-of-order CDP replies across fragmented UTF-8 and null-delimited frames", async () => {
  const { cdp, input, output } = fixture();
  let written = "";
  input.on("data", (chunk) => {
    written += chunk;
  });
  const first = cdp.send("Page.enable", {}, "session"),
    second = cdp.send("Page.navigate", { url: "日本語" }, "session");
  const requests = written
    .split("\0")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame));
  expect(requests.map((request) => request.method)).toEqual(["Page.enable", "Page.navigate"]);
  expect(requests.every((request) => request.sessionId === "session")).toBe(true);
  const bytes = Buffer.from(
    JSON.stringify({ id: 2, result: { title: "日本語" } }) +
      "\0" +
      JSON.stringify({ id: 1, result: {} }) +
      "\0",
  );
  for (const byte of bytes) output.write(Buffer.from([byte]));
  expect(await second).toEqual({ title: "日本語" });
  expect(await first).toEqual({});
});
it("reports Chromium rejection reasons and protocol errors without mixing them with replies", async () => {
  const { cdp, output } = fixture();
  const pending = cdp.send("Page.navigate");
  const rejected = expect(pending).rejects.toThrow("navigation failed");
  output.write(
    JSON.stringify({ method: "Page.backForwardCacheNotUsed", params: { reasons: ["blocked"] } }) +
      "\0",
  );
  output.write(JSON.stringify({ id: 1, error: { message: "navigation failed" } }) + "\0");
  await rejected;
  expect(cdp.events).toEqual([
    { method: "Page.backForwardCacheNotUsed", params: { reasons: ["blocked"] } },
  ]);
});
it("rejects outstanding and future calls after pipe failure", async () => {
  const { cdp, output } = fixture();
  const pending = cdp.send("Runtime.evaluate");
  const rejected = expect(pending).rejects.toThrow("Invalid Chromium CDP frame");
  output.write("malformed\0");
  await rejected;
  await expect(cdp.send("Page.enable")).rejects.toThrow("Invalid Chromium CDP frame");
});
it("expires an unanswered command and ignores its late reply", async () => {
  vi.useFakeTimers();
  const { cdp, output } = fixture();
  const pending = cdp.send("Page.enable", {}, undefined, 100);
  const rejected = expect(pending).rejects.toThrow("deadline exceeded");
  await vi.advanceTimersByTimeAsync(101);
  await rejected;
  output.write(JSON.stringify({ id: 1, result: {} }) + "\0");
  const next = cdp.send("Page.enable");
  output.write(JSON.stringify({ id: 2, result: { ready: true } }) + "\0");
  expect(await next).toEqual({ ready: true });
});

it("waits through a navigation context swap without requiring load events", async () => {
  vi.useFakeTimers();
  const { cdp, input, output } = fixture();
  let calls = 0;
  input.on("data", (chunk) => {
    const request = JSON.parse(String(chunk).replace(/\0$/, ""));
    const response =
      ++calls === 1
        ? { id: request.id, error: { message: "Cannot find default execution context" } }
        : { id: request.id, result: { result: { value: true } } };
    output.write(JSON.stringify(response) + "\0");
  });
  const ready = evaluateUntil(cdp, "session", "document.readyState === 'complete'");
  await vi.advanceTimersByTimeAsync(51);
  expect(await ready).toBe(true);
  expect(calls).toBe(2);
});
