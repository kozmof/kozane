import { expect, it, vi } from "vitest";
import {
  decodeRecovery,
  failureKind,
  RecoveryCopyError,
  restoreCandidate,
  HarnessFailure,
  RECOVERY_DB_MAX_BYTES,
  RECOVERY_ENVELOPE_MAX_CHARS,
  type RestoreOptions,
} from "../../../../../scripts/restoration-harness/recovery";
const encoded = (overrides = {}) =>
  JSON.stringify({ schemaVersion: "current", savedAt: 0, db: "AA==", ...overrides });
it("accepts future timestamps and ignores extra fields", () => {
  const result = decodeRecovery(
    encoded({ savedAt: 8_640_000_000_000_000, extra: "ignored" }),
    "current",
  );
  expect(result.savedAt).toBe(8_640_000_000_000_000);
  expect(result.bytes).toEqual(new Uint8Array([0]));
  expect(Object.hasOwn(result, "extra")).toBe(false);
});
it.each([
  null,
  [],
  false,
  0,
  "string",
  {},
  { schemaVersion: "current", savedAt: 0 },
  { schemaVersion: "", savedAt: 0, db: "AA==" },
])("rejects malformed envelope %#", (value) => {
  expect(() => decodeRecovery(JSON.stringify(value), "current")).toThrow(RecoveryCopyError);
});
it.each([-1, 1.5, 8_640_000_000_000_001, "0", null])("rejects invalid timestamps %#", (savedAt) => {
  expect(() => decodeRecovery(encoded({ savedAt }), "current")).toThrow(RecoveryCopyError);
});
it.each(["", "A", "AA", "AAA", "A===", "AA=", "AB==", "AAB=", "AA==\n", "AA-_", "===="])(
  "rejects noncanonical base64 %s",
  (db) => {
    expect(() => decodeRecovery(encoded({ db }), "current")).toThrow(RecoveryCopyError);
  },
);
it("checks size before decoding and accepts the exact database boundary", () => {
  const bytes = Buffer.alloc(RECOVERY_DB_MAX_BYTES);
  expect(decodeRecovery(encoded({ db: bytes.toString("base64") }), "current").bytes).toHaveLength(
    RECOVERY_DB_MAX_BYTES,
  );
  expect(() =>
    decodeRecovery(
      encoded({ db: Buffer.alloc(RECOVERY_DB_MAX_BYTES + 1).toString("base64") }),
      "current",
    ),
  ).toThrow(expect.objectContaining({ reason: "size" }));
  expect(() => decodeRecovery(" ".repeat(RECOVERY_ENVELOPE_MAX_CHARS + 1), "current")).toThrow(
    expect.objectContaining({ reason: "size" }),
  );
});
it("rejects incompatible migration IDs independently of package versions", () => {
  expect(() =>
    decodeRecovery(encoded({ schemaVersion: "old", packageVersion: "0.1.0" }), "current"),
  ).toThrow(expect.objectContaining({ reason: "incompatible" }));
});
function fixture(saved: string | null = encoded()) {
  const events: string[] = [];
  const storage = {
    getItem: vi.fn(() => saved),
    removeItem: vi.fn(() => {
      events.push("delete");
    }),
  };
  let sequence = 0;
  const options: RestoreOptions<string> = {
    schemaVersion: "current",
    storage: () => storage,
    sample: async () => {
      events.push("sample");
      return { bytes: new Uint8Array([1]), namespaceId: "sample" };
    },
    open: async (bytes) => {
      const id = ++sequence;
      events.push(`open:${id}:${bytes[0]}`);
      return {
        validate: async (request) => {
          events.push(`validate:${id}:${request.sampleNamespaceId ?? "restored"}`);
          return "view";
        },
        close: async () => {
          events.push(`close:${id}`);
        },
      };
    },
  };
  return { options, storage, events };
}
it("validates and closes sample preflight before restoring the copy", async () => {
  const { options, storage, events } = fixture();
  const result = await restoreCandidate(options);
  expect(result).toMatchObject({ status: "ready", source: "restored" });
  expect(events).toEqual([
    "sample",
    "open:1:1",
    "validate:1:sample",
    "close:1",
    "open:2:0",
    "validate:2:restored",
  ]);
  expect(storage.removeItem).not.toHaveBeenCalled();
  if (result.status === "ready") await result.candidate.close();
});
it.each(["malformed", "incompatible", "size"] as const)(
  "defers deletion of %s recovery until sample fallback validates",
  async (reason) => {
    const text =
      reason === "malformed"
        ? "invalid"
        : reason === "incompatible"
          ? encoded({ schemaVersion: "old" })
          : " ".repeat(RECOVERY_ENVELOPE_MAX_CHARS + 1);
    const { options, events } = fixture(text);
    expect(await restoreCandidate(options)).toMatchObject({
      status: "ready",
      source: "sample",
      fallbackReason: reason,
    });
    expect(events).toEqual([
      "sample",
      "open:1:1",
      "validate:1:sample",
      "close:1",
      "open:2:1",
      "validate:2:sample",
      "delete",
    ]);
  },
);
it.each(["unknown", "transient", "database_content", "asset"] as const)(
  "preserves saved data when sample preflight fails with %s",
  async (kind) => {
    const { options, storage } = fixture("invalid");
    options.open = async () => ({
      validate: async () => {
        throw new HarnessFailure(kind, "injected");
      },
      close: async () => {},
    });
    expect(await restoreCandidate(options)).toEqual({
      status: "unavailable",
      kind,
      action: kind === "database_content" || kind === "asset" ? "reload" : "retry",
    });
    expect(storage.removeItem).not.toHaveBeenCalled();
  },
);
it.each(["unknown", "transient", "database_content"] as const)(
  "uses conservative fallback for restored %s failures",
  async (kind) => {
    const { options, storage, events } = fixture();
    const original = options.open;
    options.open = async (bytes) => {
      if (bytes[0] === 0)
        return {
          validate: async () => {
            throw new HarnessFailure(kind, "injected");
          },
          close: async () => {
            events.push("rejected-closed");
          },
        };
      return original(bytes);
    };
    const result = await restoreCandidate(options);
    if (kind === "database_content") {
      expect(result).toMatchObject({ status: "ready", source: "sample" });
      expect(events.indexOf("rejected-closed")).toBeLessThan(events.indexOf("open:2:1"));
      expect(storage.removeItem).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({ status: "unavailable", action: "retry", kind });
      expect(storage.removeItem).not.toHaveBeenCalled();
    }
  },
);
it("preserves an invalid copy when fallback view validation fails", async () => {
  const { options, storage } = fixture("invalid");
  let opens = 0;
  options.open = async () => ({
    validate: async () => {
      if (++opens === 2) throw new Error("service read lost");
      return "view";
    },
    close: async () => {},
  });
  expect(await restoreCandidate(options)).toEqual({
    status: "unavailable",
    action: "retry",
    kind: "unknown",
  });
  expect(storage.removeItem).not.toHaveBeenCalled();
});
it("does not authorize fallback after failed candidate cleanup", async () => {
  const { options, storage } = fixture();
  const original = options.open;
  options.open = async (bytes) =>
    bytes[0]
      ? original(bytes)
      : {
          validate: async () => {
            throw new HarnessFailure("database_content", "bad data");
          },
          close: async () => {
            throw new HarnessFailure("database_content", "cleanup failed");
          },
        };
  expect(await restoreCandidate(options)).toEqual({
    status: "unavailable",
    action: "retry",
    kind: "unknown",
  });
  expect(storage.removeItem).not.toHaveBeenCalled();
});
it("allows memory startup when storage access fails and reports failed deletion", async () => {
  const missing = fixture(null);
  missing.options.storage = () => {
    throw new Error("SecurityError");
  };
  expect(await restoreCandidate(missing.options)).toMatchObject({
    status: "ready",
    source: "sample",
    recoveryUnavailable: true,
  });
  const rejected = fixture("invalid");
  rejected.storage.removeItem.mockImplementation(() => {
    throw new Error("SecurityError");
  });
  expect(await restoreCandidate(rejected.options)).toMatchObject({
    status: "ready",
    source: "sample",
    recoveryUnavailable: true,
    olderCopyMayRestore: true,
  });
});

it("retains structured classifications through driver causes and stops at cleanup uncertainty", () => {
  const defect = new HarnessFailure("database_content", "confirmed code");
  expect(failureKind(new Error("driver query failed", { cause: defect }))).toBe("database_content");
  const cleanup = new HarnessFailure("unknown", "rollback failed");
  Object.defineProperty(cleanup, "cause", { value: defect });
  expect(failureKind(cleanup)).toBe("unknown");
  const cycle = new Error("cycle");
  Object.defineProperty(cycle, "cause", { value: cycle });
  expect(failureKind(cycle)).toBe("unknown");
});
