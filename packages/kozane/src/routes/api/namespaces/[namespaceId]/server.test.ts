import { expect, it } from "vitest";
import { createTestDB } from "../../../../test-utils/db.js";
import { createNamespace } from "../../../../db/api/namespace.js";
import { GET } from "./+server";

it("returns namespace metadata and a domain-coded missing-resource error", async () => {
  const db = await createTestDB();
  const id = await createNamespace({ db, name: "Named" });
  const event = { locals: { db }, params: { namespaceId: id } } as Parameters<typeof GET>[0];
  expect(await (await GET(event)).json()).toEqual({ id, name: "Named", isDefault: false });
  const headers: Record<string, string> = {};
  await expect(
    GET({
      ...event,
      params: { namespaceId: "missing" },
      setHeaders: (values) => Object.assign(headers, values),
    }),
  ).rejects.toMatchObject({ status: 404, body: { message: "Namespace not found" } });
  expect(headers).toEqual({ "X-Kozane-Error-Code": "not_found" });
});
