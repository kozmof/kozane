import { expect, it } from "vitest";
import { createTestDB } from "../../../test-utils/db.js";
import { getAllLayers } from "../../../db/api/layer.js";
import { getAllPartitions } from "../../../db/api/partition.js";
import { GET, POST } from "./+server";
it("creates complete namespace metadata and defaults without selecting a new default", async () => {
  const db = await createTestDB();
  const event = {
    locals: { db },
    request: new Request("http://localhost/api/namespaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Created" }),
    }),
  } as Parameters<typeof POST>[0];
  const response = await POST(event);
  const created = await response.json();
  expect(created).toMatchObject({ name: "Created", isDefault: false });
  expect(typeof created.id).toBe("string");
  expect(await getAllLayers({ db, namespaceId: created.id })).toHaveLength(1);
  expect(await getAllPartitions({ db, namespaceId: created.id })).toHaveLength(1);
  const listed = await GET({ locals: { db } } as Parameters<typeof GET>[0]);
  expect(await listed.json()).toEqual([created]);
});
