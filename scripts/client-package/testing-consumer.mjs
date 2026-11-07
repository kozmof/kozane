import assert from "node:assert/strict";
import { StaticBackend, HttpBackend } from "@kozane/client";
import { backendContractCases, runBackendContract } from "@kozane/client/testing";
import * as database from "@kozane/core/database";
import * as services from "@kozane/core/services";
import * as schema from "@kozane/core/schema";
import { applyMigrations } from "@kozane/core/migrations";
import { domainErrorCode } from "@kozane/core";
import { createServiceContractFixture } from "./testing-http-fixture.mjs";
const namespaces = [{ id: "seed", name: "Contract seed", isDefault: true }];
const snapshot = {
  namespace: { id: "seed" },
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
let cleanups = 0;
for (const kind of ["static", "http"]) {
  const create = () => ({
    backend:
      kind === "static"
        ? new StaticBackend({ namespaces, snapshots: [snapshot] })
        : new HttpBackend({
            capabilities: {
              writable: false,
              persistent: true,
              taskspaces: false,
              externalWrites: false,
              auth: false,
            },
            fetcher: async (input) => {
              const path = String(input);
              if (path === "/api/namespaces") return Response.json(namespaces);
              if (path === "/api/namespaces/seed") return Response.json(namespaces[0]);
              if (path === "/seed/api/snapshot") return Response.json(snapshot);
              if (path.includes("snapshot"))
                return Response.json({ message: "Not found" }, { status: 404 });
              return Response.json({ message: "Dataset unavailable" }, { status: 503 });
            },
          }),
    namespaceId: "seed",
    unavailableDatasets: ["tags", "map", "warpDirectory"],
    cleanup: () => {
      cleanups++;
    },
  });
  const before = cleanups;
  const cases = backendContractCases(create);
  const passed = await runBackendContract(create);
  assert.equal(passed.length, cases.length);
  assert.equal(cleanups - before, cases.length);
  assert.ok(passed.includes("read-only cards.create"));
}
const writable = await runBackendContract(
  () =>
    createServiceContractFixture({
      database,
      services,
      schema,
      migrate: applyMigrations,
      HttpBackend,
      domainErrorCode,
    }),
  { mode: "writable" },
);
assert.ok(writable.includes("card CRUD publishes committed versions"));
console.log(
  `Packed testing entry passed direct Node imports and public contracts (${cleanups} read-only cases and ${writable.length} service-backed writable cases).`,
);
