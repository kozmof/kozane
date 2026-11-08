import { describe, expect, it } from "vitest";
import { parsePort, resolvePort } from "./port.js";

describe("parsePort", () => {
  it("accepts ports in range, including 0 for an ephemeral port", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("17173")).toBe(17173);
    expect(parsePort(" 8080 ")).toBe(8080);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects non-numeric, fractional, negative, and out-of-range values", () => {
    expect(parsePort("")).toBeNull();
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("80.5")).toBeNull();
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("0x50")).toBeNull();
  });
});

describe("resolvePort", () => {
  it("prefers the flag, then the env var, then config, then the fallback", () => {
    expect(resolvePort({ flag: "1234", env: "2345", config: 3456, fallback: 17173 })).toBe(1234);
    expect(resolvePort({ env: "2345", config: 3456, fallback: 17173 })).toBe(2345);
    expect(resolvePort({ config: 3456, fallback: 17173 })).toBe(3456);
    expect(resolvePort({ fallback: 17173 })).toBe(17173);
  });

  it("ignores an empty env var", () => {
    expect(resolvePort({ env: "", config: 3456, fallback: 17173 })).toBe(3456);
    expect(resolvePort({ env: "  ", fallback: 17173 })).toBe(17173);
  });

  it("throws on an invalid flag instead of falling through", () => {
    expect(() => resolvePort({ flag: "nope", config: 3456, fallback: 17173 })).toThrow(
      /Invalid --port "nope"/,
    );
  });

  it("throws on an invalid env var, naming it", () => {
    expect(() => resolvePort({ env: "99999", fallback: 17173 })).toThrow(
      /Invalid KOZANE_PORT "99999"/,
    );
    expect(() =>
      resolvePort({ env: "99999", envName: "KOZANE_PREVIEW_PORT", fallback: 17174 }),
    ).toThrow(/Invalid KOZANE_PREVIEW_PORT/);
  });
});
