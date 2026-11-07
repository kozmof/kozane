import { expect, it, vi } from "vitest";
import { HttpTransport, retryAfterMilliseconds, KEEPALIVE_BYTES_MAX } from "./http-transport.js";
import { INPUT_VALIDATION_MESSAGE } from "../../../../src/services/prepare-input.js";
const jsonError = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ message: "existing wording" }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
it.each([
  [400, "validation"],
  [404, "not_found"],
  [409, "conflict"],
  [413, "limit"],
  [500, "unavailable"],
] as const)("maps legacy status %s", async (status, code) => {
  const transport = new HttpTransport((path) => path, {
    fetcher: vi.fn().mockResolvedValue(jsonError(status)),
  });
  await expect(transport.request("/resource")).rejects.toMatchObject({
    code,
    message: "existing wording",
  });
});
it("uses allowlisted domain headers while keeping authentication and throttling authoritative", async () => {
  for (const [status, header, code] of [
    [400, "conflict", "conflict"],
    [401, "conflict", "unauthenticated"],
    [403, "validation", "forbidden"],
    [429, "conflict", "rate_limited"],
    [400, "invented", "validation"],
  ] as const) {
    const transport = new HttpTransport((path) => path, {
      fetcher: vi
        .fn()
        .mockResolvedValue(jsonError(Number(status), { "X-Kozane-Error-Code": header })),
    });
    await expect(transport.request("/resource")).rejects.toMatchObject({ code });
  }
});
it("uses safe fallbacks for malformed JSON and plain text errors", async () => {
  for (const response of [
    new Response("<secret>", { status: 500 }),
    new Response("{broken", { status: 500, headers: { "content-type": "application/json" } }),
  ]) {
    const transport = new HttpTransport((path) => path, {
      fetcher: vi.fn().mockResolvedValue(response),
    });
    await expect(transport.request("/resource")).rejects.toMatchObject({
      code: "unavailable",
      message: "The backend is unavailable",
    });
  }
});
it("shares a monotonic throttle deadline without retaining rejected mutations", async () => {
  let now = 100;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(jsonError(429, { "retry-after": "2" }))
    .mockResolvedValue(new Response("ok"));
  const transport = new HttpTransport((path) => path, { fetcher, monotonicNow: () => now });
  await expect(transport.request("/read")).rejects.toMatchObject({ retryAfterMs: 2000 });
  now = 600;
  await expect(transport.request("/write", "POST", { content: "private" })).rejects.toMatchObject({
    code: "rate_limited",
    retryAfterMs: 1500,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  now = 2100;
  await transport.request("/read");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("prepares input before dispatch and applies the UTF-8 keepalive byte guard", async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response("ok"));
  const transport = new HttpTransport((path) => path, { fetcher });
  await expect(transport.request("/write", "POST", { invalid: NaN })).rejects.toMatchObject({
    code: "validation",
    message: INPUT_VALIDATION_MESSAGE,
  });
  expect(fetcher).not.toHaveBeenCalled();
  for (const content of ["small", "界".repeat(KEEPALIVE_BYTES_MAX / 2)])
    await transport.request("/write", "POST", { content }, { keepalive: true });
  expect(fetcher.mock.calls[0][1].keepalive).toBe(true);
  expect(fetcher.mock.calls[1][1].keepalive).toBe(false);
});
it("does not turn fetch failures into database errors", async () => {
  const transport = new HttpTransport((path) => path, {
    fetcher: vi.fn().mockRejectedValue(new Error("offline")),
  });
  await expect(transport.request("/read")).rejects.toMatchObject({ code: "network" });
});
it("parses nonnegative seconds and future dates with the required fallback", () => {
  expect(retryAfterMilliseconds("0", 0)).toBe(0);
  expect(retryAfterMilliseconds("1.5", 0)).toBe(1500);
  expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000);
  for (const value of [null, "", "invalid", "-1", "Thu, 01 Jan 1970 00:00:00 GMT"])
    expect(retryAfterMilliseconds(value, 1000)).toBe(1000);
});

it("never shortens throttling when already-dispatched requests settle later", async () => {
  let now = 0;
  const replies: ((response: Response) => void)[] = [];
  const fetcher = vi
    .fn()
    .mockImplementation(() => new Promise<Response>((resolve) => replies.push(resolve)));
  const transport = new HttpTransport((path) => path, { fetcher, monotonicNow: () => now });
  const first = expect(transport.request("/one")).rejects.toMatchObject({ code: "rate_limited" });
  const second = expect(transport.request("/two")).rejects.toMatchObject({ code: "rate_limited" });
  replies[0](jsonError(429, { "retry-after": "2" }));
  await first;
  now = 500;
  replies[1](jsonError(429, { "retry-after": "0.1" }));
  await second;
  expect(transport.retryAfterMs).toBe(1500);
  await expect(transport.request("/three")).rejects.toMatchObject({ retryAfterMs: 1500 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
