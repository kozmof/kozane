import { expect, it } from "vitest";
import { createTestDB } from "../../../test-utils/db.js";
import { createNamespace } from "../../../db/api/namespace.js";
import { getDefaultPartition } from "../../../db/api/partition.js";
import { create } from "../../../services/cards.js";
import { createServiceContext } from "../../../services/context.js";
import { GET } from "./+server";
import { GET as getMap } from "../map/+server";
it("serves shared tag and map datasets and rejects unknown destinations", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "View fixture" });
  const partition = await getDefaultPartition({ db, namespaceId });
  await create(db, createServiceContext(), namespaceId, {
    partitionId: partition!.id,
    content: "View card #topic",
  });
  const event = {
    locals: { db },
    url: new URL("http://localhost/api/tags?namespaceId=" + namespaceId),
  } as Parameters<typeof GET>[0];
  const tags = await (await GET(event)).json();
  expect(tags.namespaces[0].id).toBe(namespaceId);
  expect(tags.index.cardNamespaces).toBeDefined();
  expect(tags.partitions).toBeDefined();
  const map = await (await getMap({ locals: { db } } as Parameters<typeof getMap>[0])).json();
  expect(map.namespaces[0].id).toBe(namespaceId);
  expect(map.partitions[0].cards).toBe(1);
  await expect(
    GET({ ...event, url: new URL("http://localhost/api/tags?namespaceId=missing") }),
  ).rejects.toMatchObject({ status: 404 });
});
