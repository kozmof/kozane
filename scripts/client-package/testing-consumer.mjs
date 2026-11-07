import assert from "node:assert/strict";
import {
  StaticBackend,
  HttpBackend,
  DEFAULT_UI_CONFIG,
  parseUiOverrides,
  validateUiOverrides,
  ARROW_KEYS,
  clampZoom,
} from "@kozane/client";
import { backendContractCases, runBackendContract } from "@kozane/client/testing";
import * as database from "@kozane/core/database";
import * as services from "@kozane/core/services";
import * as schema from "@kozane/core/schema";
import { applyMigrations } from "@kozane/core/migrations";
import { domainErrorCode } from "@kozane/core";
import { createServiceContractFixture } from "./testing-http-fixture.mjs";
assert.equal(DEFAULT_UI_CONFIG.defaultCardWidth, 210);
assert.deepEqual(parseUiOverrides({ defaultCardWidth: 240 }, { strict: true }), {
  defaultCardWidth: 240,
});
assert.equal(validateUiOverrides({ defaultCardWidth: 0 }).issues[0].severity, "error");
assert.throws(
  () => parseUiOverrides({ defaultCardWidth: 0 }, { strict: true }),
  /Invalid Kozane config/,
);
assert.deepEqual(ARROW_KEYS, ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
assert.equal(clampZoom(3), 2);
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
