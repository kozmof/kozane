import assert from "node:assert/strict";
import {
  StaticClient,
  HttpClient,
  DEFAULT_UI_CONFIG,
  parseUiOverrides,
  validateUiOverrides,
  ARROW_KEYS,
  clampZoom,
  cardMetrics,
  textCells,
  estimateCardHeight,
  nearestCardHint,
  truncationReasons,
  truncationPaths,
  cleanupCommandTail,
  TASKSPACE_CLEANUP_COMMAND,
  MAP_TAG_LINKS_MAX,
  MAP_DEFAULT_VIEWPORT,
  TAG_HITS_SHOWN_MAX,
} from "@kozane/client";
import { clientContractCases, runClientContract } from "@kozane/client/testing";
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
const metrics = cardMetrics({ defaultCardWidth: 200, defaultFontSize: 10 });
assert.deepEqual(metrics, { cardWidth: 200, fontSize: 10 });
assert.equal(textCells("a日本😀"), 7);
assert.equal(estimateCardHeight("short", metrics), 68);
assert.equal(
  nearestCardHint({ posX: 0, posY: 0 }, [{ posX: 0, posY: 0, content: "Nearest hint" }], metrics),
  "Nearest hint",
);
assert.match(truncationReasons(["entries"]), /directory held more entries/);
assert.equal(truncationPaths(["notes.md"]), " (for example notes.md)");
assert.equal(cleanupCommandTail(1), "to drop the record.");
assert.equal(cleanupCommandTail(2), "to drop the records.");
assert.equal(TASKSPACE_CLEANUP_COMMAND, "kozane taskspace scan --apply --cleanup");
assert.equal(MAP_TAG_LINKS_MAX, 20000);
assert.deepEqual(MAP_DEFAULT_VIEWPORT, { width: 1600, height: 1000 });
assert.equal(TAG_HITS_SHOWN_MAX, 200);
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
    client:
      kind === "static"
        ? new StaticClient({ namespaces, snapshots: [snapshot] })
        : new HttpClient({
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
  const cases = clientContractCases(create);
  const passed = await runClientContract(create);
  assert.equal(passed.length, cases.length);
  assert.equal(cleanups - before, cases.length);
  assert.ok(passed.includes("read-only cards.create"));
}
const writable = await runClientContract(
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
assert.ok(writable.includes("card CRUD publishes committed versions"));
console.log(
  `Packed testing entry passed direct Node imports and public contracts (${cleanups} read-only cases and ${writable.length} service-backed writable cases).`,
);
