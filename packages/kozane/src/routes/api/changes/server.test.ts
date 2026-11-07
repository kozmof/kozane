import { expect, it, vi } from "vitest";
import { createTestDB } from "../../../test-utils/db.js";
import { namespaceTable } from "../../../db/schema.js";
import { GET } from "./+server";

vi.mock("../../../db/client.js", () => ({ openedDbUrl: () => ":memory:" }));

it("serves an uncached opaque token that changes after a committed mutation", async () => {
  const db = await createTestDB();
  const event = { locals: { db } } as Parameters<typeof GET>[0];
  const response = await GET(event);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const before = await response.json();
  expect(before.token).toEqual(expect.any(String));
  expect(await (await GET(event)).json()).toEqual(before);
  await db.insert(namespaceTable).values({ name: "Private namespace" });
  const after = await (await GET(event)).json();
  expect(after.token).not.toBe(before.token);
  expect(after.token).not.toContain("Private");
});
