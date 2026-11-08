import { expect, it } from "vitest";
import { StaticClient } from "../../../../client/src/client/static-client.js";
import { HttpClient } from "../../../../client/src/client/http-client.js";
import {
  clientContractCases,
  runClientContract,
  ClientContractFailure,
} from "../../../../client/src/client/testing/index.js";
import * as database from "../../db/database";
import * as services from "../../services/index";
import * as schema from "../../db/schema";
import { applyMigrations } from "@kozane/core/migrations";
import { domainErrorCode } from "../../services/error-code";
import { createServiceContractFixture } from "../../../../../scripts/client-package/testing-http-fixture.mjs";
function fixture() {
  const backend = new StaticClient({
    namespaces: [{ id: "ns", name: "Fixture", isDefault: true }],
    snapshots: [
      {
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
      },
    ],
  });
  return {
    backend,
    namespaceId: "ns",
    unavailableDatasets: ["tags", "map", "warpDirectory"] as const,
  };
}
it("runs the read-only catalog with one fresh fixture and cleanup per case", async () => {
  let created = 0,
    cleaned = 0;
  const create = () => {
    created++;
    return {
      ...fixture(),
      cleanup: () => {
        cleaned++;
      },
    };
  };
  const cases = clientContractCases(create);
  expect(created).toBe(0);
  const passed = await runClientContract(create);
  expect(passed.length).toBe(cases.length);
  expect(created).toBe(cases.length);
  expect(cleaned).toBe(cases.length);
  expect(passed).toContain("read-only namespaces.create");
});
it("runs writable cases against real native SQLite services through HTTP", async () => {
  const cases = await runClientContract(
    () =>
      createServiceContractFixture({
        database,
        services,
        schema,
        migrate: applyMigrations,
        HttpClient,
        domainErrorCode,
      }),
    { mode: "writable" },
  );
  expect(cases).toContain("card CRUD publishes committed versions");
  expect(cases).toContain("invalid card creation leaves version unchanged");
});
it("annotates factory failures with the case name", async () => {
  const test = clientContractCases(async () => {
    throw new Error("Cannot initialize");
  })[0];
  await expect(test.run()).rejects.toMatchObject({
    name: "ClientContractFailure",
    caseName: test.name,
    cause: { message: "Cannot initialize" },
  });
});
it("cleans up failed cases and preserves a simultaneous cleanup failure", async () => {
  let cleaned = false;
  const test = clientContractCases(
    () => ({
      ...fixture(),
      cleanup: () => {
        cleaned = true;
        throw new Error("Cleanup failed");
      },
    }),
    { mode: "writable" },
  )[0];
  try {
    await test.run();
    throw new Error("Expected contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ClientContractFailure);
    expect((error as ClientContractFailure).cause).toBeInstanceOf(AggregateError);
  }
  expect(cleaned).toBe(true);
});
it("detects a backend that ignores conditional snapshot validators", async () => {
  let cleaned = false;
  const test = clientContractCases(() => {
    const base = fixture();
    const backend = new Proxy(base.backend, {
      get(target, key, receiver) {
        if (key === "snapshot") return (id: string) => target.snapshot(id);
        return Reflect.get(target, key, receiver);
      },
    });
    return {
      ...base,
      backend,
      cleanup: () => {
        cleaned = true;
      },
    };
  }).find((test) => test.name === "snapshot validators are stable")!;
  await expect(test.run()).rejects.toThrow(/retain its validator/);
  expect(cleaned).toBe(true);
});
it("reports a failed dataset read and still cleans up", async () => {
  let cleaned = false;
  const test = clientContractCases(() => {
    const base = fixture();
    return {
      ...base,
      unavailableDatasets: [],
      cleanup: () => {
        cleaned = true;
      },
    };
  }).find((test) => test.name === "tags reads obey availability")!;
  await expect(test.run()).rejects.toBeInstanceOf(ClientContractFailure);
  expect(cleaned).toBe(true);
});
