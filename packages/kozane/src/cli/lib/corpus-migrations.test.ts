import { expect, it, vi } from "vitest";
import {
  migrationCompatibility,
  planCorpusCompatibility,
} from "../../../../../scripts/restoration-harness/corpus-compatibility";
import {
  HarnessFailure,
  restoreCandidate,
} from "../../../../../scripts/restoration-harness/recovery";
it("keeps same-ID outcomes mandatory and distinguishes known earlier IDs", () => {
  expect(migrationCompatibility("current", "current", ["earlier", "current"])).toBe("same");
  expect(migrationCompatibility("earlier", "current", ["earlier", "current"])).toBe("incompatible");
  expect(
    planCorpusCompatibility(["earlier", "current"], "current", ["earlier", "current"]),
  ).toEqual(["incompatible", "same"]);
});
it.each(
  [[], ["earlier"], ["current", "earlier"], ["earlier", "current", "current"], ["", "current"]].map(
    (ids) => ({ ids }),
  ),
)("rejects invalid candidate history %#", ({ ids }) => {
  expect(() => migrationCompatibility("earlier", "current", ids)).toThrow(
    /Candidate migration history/,
  );
});
it.each(["unknown", "future", ""])("rejects unrecognized producer migration %s", (id) => {
  expect(() => migrationCompatibility(id, "current", ["earlier", "current"])).toThrow(
    /Unknown retained producer/,
  );
});
it("requires positive fixtures for a new migration ID instead of accepting only fallback checks", () => {
  expect(() => planCorpusCompatibility(["earlier"], "current", ["earlier", "current"])).toThrow(
    /Retain a producer cohort/,
  );
  expect(() => planCorpusCompatibility([], "current", ["earlier", "current"])).toThrow(
    /Retain a producer cohort/,
  );
});
it.each([false, true])(
  "deletes an earlier-ID copy only after valid sample fallback (sample fails %s)",
  async (fails) => {
    expect(migrationCompatibility("earlier", "current", ["earlier", "current"])).toBe(
      "incompatible",
    );
    const original = JSON.stringify({ schemaVersion: "earlier", savedAt: 0, db: "AQ==" });
    let saved: string | null = original;
    const sample = new Uint8Array([2]);
    const validate = vi.fn(async () => {
      expect(saved).toBe(original);
      if (fails) throw new HarnessFailure("database_content", "Sample defect");
      return { kind: "selected" };
    });
    const open = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes).toEqual(sample);
      return { validate, close: async () => {} };
    });
    const result = await restoreCandidate({
      schemaVersion: "current",
      storage: () => ({
        getItem: () => saved,
        removeItem: () => {
          saved = null;
        },
      }),
      sample: async () => ({ bytes: sample, namespaceId: "sample" }),
      open,
    });
    if (fails) {
      expect(result).toMatchObject({
        status: "unavailable",
        action: "reload",
        kind: "database_content",
      });
      expect(saved).toBe(original);
      expect(open).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({
        status: "ready",
        source: "sample",
        fallbackReason: "incompatible",
      });
      expect(saved).toBeNull();
      expect(open).toHaveBeenCalledTimes(2);
      if (result.status === "ready") await result.candidate.close();
    }
  },
);
