import { describe, expect, it } from "vitest";
import { getAllPartitions } from "../db/api/partition.js";
import { getAllLayers } from "../db/api/layer.js";
import { getAllNamespaces } from "../db/api/namespace.js";
import type { DB } from "../db/tx.js";
import { createTestDB } from "../test-utils/db.js";
import { NAME_MAX } from "$lib/constants";
import { actions } from "./+page.server.js";

function submit(db: DB, name: string | null) {
  const body = new FormData();
  if (name !== null) body.set("name", name);
  const request = new Request("http://localhost/", { method: "POST", body });
  const create = actions?.default;
  if (!create) throw new Error("The create-namespace action is not exported");
  return create({ locals: { db }, request } as never);
}

describe("POST / (create namespace)", () => {
  it("creates a namespace with its default partition and layer", async () => {
    const db = await createTestDB();

    expect(await submit(db, "  Browser namespace  ")).toEqual({ success: true });

    const [namespace] = await getAllNamespaces({ db });
    expect(namespace).toMatchObject({ name: "Browser namespace", isDefault: false });
    expect(await getAllPartitions({ db, namespaceId: namespace.id })).toHaveLength(1);
    expect(await getAllLayers({ db, namespaceId: namespace.id })).toHaveLength(1);
  });

  it("rejects a missing name", async () => {
    const db = await createTestDB();

    expect(await submit(db, null)).toMatchObject({
      status: 400,
      data: { error: "Namespace name is required." },
    });
    expect(await getAllNamespaces({ db })).toEqual([]);
  });

  it("rejects a blank name", async () => {
    const db = await createTestDB();

    expect(await submit(db, "   ")).toMatchObject({
      status: 400,
      data: { error: "Namespace name is required." },
    });
    expect(await getAllNamespaces({ db })).toEqual([]);
  });

  it("rejects a name past the length limit", async () => {
    const db = await createTestDB();

    expect(await submit(db, "x".repeat(NAME_MAX + 1))).toMatchObject({
      status: 400,
      data: { error: `Namespace name must be ${NAME_MAX} characters or fewer.` },
    });
    expect(await getAllNamespaces({ db })).toEqual([]);
  });

  it("allows a name another namespace already uses, as the CLI does", async () => {
    const db = await createTestDB();

    await submit(db, "Twin");
    await submit(db, "Twin");

    expect((await getAllNamespaces({ db })).map(({ name }) => name)).toEqual(["Twin", "Twin"]);
  });
});
