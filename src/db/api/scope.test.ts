import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { addScope, getScope, getAllScopes, updateScopeName, deleteScope } from "./scope.js";
import { NotFoundError } from "./utils.js";

async function db() {
  return createTestDB();
}

describe("addScope", () => {
  it("returns a non-empty id", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "Release" });
    expect(id).toBeTruthy();
  });

  it("defaults name to empty string when omitted", async () => {
    const d = await db();
    const id = await addScope({ db: d });
    const scope = await getScope({ db: d, scopeId: id });
    expect(scope?.name).toBe("");
  });

  it("assigns unique ids", async () => {
    const d = await db();
    const id1 = await addScope({ db: d, name: "A" });
    const id2 = await addScope({ db: d, name: "B" });
    expect(id1).not.toBe(id2);
  });
});

describe("getScope", () => {
  it("returns the scope with matching id", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "Sprint 1" });
    const scope = await getScope({ db: d, scopeId: id });
    expect(scope).toEqual({ id, name: "Sprint 1" });
  });

  it("returns undefined for a missing id", async () => {
    const d = await db();
    expect(await getScope({ db: d, scopeId: "ghost" })).toBeUndefined();
  });
});

describe("getAllScopes", () => {
  it("returns empty array when no scopes exist", async () => {
    const d = await db();
    expect(await getAllScopes({ db: d })).toEqual([]);
  });

  it("returns all created scopes", async () => {
    const d = await db();
    const id1 = await addScope({ db: d, name: "Alpha" });
    const id2 = await addScope({ db: d, name: "Beta" });
    const scopes = await getAllScopes({ db: d });
    expect(scopes.map((s) => s.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(scopes).toHaveLength(2);
  });
});

describe("updateScopeName", () => {
  it("changes the scope name", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "Old" });
    await updateScopeName({ db: d, scopeId: id, name: "New" });
    const scope = await getScope({ db: d, scopeId: id });
    expect(scope?.name).toBe("New");
  });

  it("throws NotFoundError for a missing scope", async () => {
    const d = await db();
    await expect(updateScopeName({ db: d, scopeId: "ghost", name: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("deleteScope", () => {
  it("removes the scope", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "ToDelete" });
    await deleteScope({ db: d, scopeId: id });
    expect(await getScope({ db: d, scopeId: id })).toBeUndefined();
  });

  it("throws NotFoundError for a missing scope", async () => {
    const d = await db();
    await expect(deleteScope({ db: d, scopeId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});
