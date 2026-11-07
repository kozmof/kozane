import { expect, it } from "vitest";
import { SnapshotValidators } from "../../src/backend/snapshot-validators.js";
import type { SnapshotData } from "../../src/backend/contract.js";
const data: SnapshotData = {
  namespace: { id: "ns" },
  cards: [],
  partitions: [],
  layers: [],
  warps: [],
  inventories: [],
  scopes: [],
  scopeAreas: [],
  scopeRels: [],
  glueRels: [],
  taskspaces: [],
};
it("returns data without a validator and omits data for a matching binding", () => {
  const validators = new SnapshotValidators();
  const first = validators.result("ns", 0, "revision", data);
  expect(first.status).toBe("changed");
  expect(validators.result("ns", 0, "revision", data, first.validator)).toEqual({
    status: "unchanged",
    validator: first.validator,
  });
  expect(validators.result("ns", 0, "new-revision", data, first.validator).status).toBe("changed");
});
it("rejects cross-instance namespace and generation bindings even with identical data", () => {
  const validators = new SnapshotValidators();
  const first = validators.result("ns", 0, "same", data);
  for (const [ns, generation] of [
    ["other", 0],
    ["ns", 1],
  ] as const)
    expect(validators.result(ns, generation, "same", data, first.validator).status).toBe("changed");
  expect(new SnapshotValidators().result("ns", 0, "same", data, first.validator).status).toBe(
    "changed",
  );
});
it("unknown evicted and cleared validators force a complete changed result", () => {
  const validators = new SnapshotValidators(1);
  const first = validators.result("ns", 0, "same", data);
  validators.result("ns", 0, "same", data);
  expect(validators.result("ns", 0, "same", data, first.validator).status).toBe("changed");
  const current = validators.result("ns", 0, "same", data);
  validators.clear();
  expect(validators.result("ns", 0, "same", data, current.validator).status).toBe("changed");
  expect(validators.result("ns", 0, "same", data, "unknown").status).toBe("changed");
});
