import { expect, it } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { namespaceTable } from "../../db/schema.js";
import { workspaceChangeToken } from "./workspace-change-token";
import { UnavailableError } from "../../services/errors";
it("returns stable memory tokens until a committed write without leaking content", async () => {
  const db = await createTestDB();
  const before = workspaceChangeToken(db, ":memory:");
  expect(workspaceChangeToken(db, ":memory:")).toBe(before);
  await db.insert(namespaceTable).values({ name: "private namespace" });
  const after = workspaceChangeToken(db, ":memory:");
  expect(after).not.toBe(before);
  expect(after).not.toContain("private");
});
it("treats missing or unreadable database metadata as unavailable", async () => {
  const db = await createTestDB();
  expect(() => workspaceChangeToken(db, "file:/missing-kozane-change-token/database.db")).toThrow(
    UnavailableError,
  );
});
