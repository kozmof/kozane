import { beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTx } from "../database.js";
import { createTestDB } from "../../test-utils/db.js";
import { createNamespace } from "./namespace.js";
import { cardTable, layerTable, partitionTable, localImageUploadTable } from "../schema.js";
import { completeImageUploadsInTx } from "./image-upload.js";

let db: Awaited<ReturnType<typeof createTestDB>>;
const first = "00000000-0000-4000-8000-000000000001.svg";
const second = "00000000-0000-4000-8000-000000000002.svg";
const pending = "00000000-0000-4000-8000-000000000003.svg";
let layerId: string;
let partitionId: string;
const reference = (id: string, filename: string) =>
  db
    .insert(cardTable)
    .values({ id, layerId, partitionId, content: "kozane-image:/api/images/" + filename });
const complete = () => withTx(db, completeImageUploadsInTx);
beforeEach(async () => {
  db = await createTestDB();
  await createNamespace({ db, name: "Main" });
  layerId = (await db.select().from(layerTable))[0].id;
  partitionId = (await db.select().from(partitionTable))[0].id;
  const installed = {
    byteLength: 3,
    sha256: "a".repeat(64),
    state: "installed" as const,
    createdAt: new Date(1000),
    installedAt: new Date(2000),
  };
  await db.insert(localImageUploadTable).values([
    { ...installed, filename: first },
    { ...installed, filename: second },
    { ...installed, filename: pending, state: "pending", installedAt: null },
  ]);
  await reference("first", first);
});

async function timestamps() {
  return (
    await db.values(sql`SELECT typeof(created_at),hex(created_at),
    CASE WHEN typeof(created_at)='real' THEN created_at ELSE NULL END,
    typeof(installed_at),hex(installed_at),
    CASE WHEN typeof(installed_at)='real' THEN installed_at ELSE NULL END
    FROM local_image_upload WHERE filename=${first}`)
  ).map((row) => Array.from(row));
}

it.each([
  "9007199254740993",
  "-9007199254740995",
  "1.0000000000000002",
  "CAST(x'610062' AS TEXT)",
  "x'80ff00'",
  "CAST('1e999' AS REAL)",
])("completes a linked pin without decoding or changing SQL timestamps %s", async (value) => {
  await db.run(
    sql.raw(`UPDATE local_image_upload SET created_at=${value},installed_at=${value}
  WHERE filename='${first}'`),
  );
  const before = await timestamps();
  await complete();
  expect(await timestamps()).toEqual(before);
  expect(
    (
      await db
        .select({ state: localImageUploadTable.state })
        .from(localImageUploadTable)
        .where(eq(localImageUploadTable.filename, first))
    )[0].state,
  ).toBe("completed");
  expect(
    (
      await db
        .select()
        .from(localImageUploadTable)
        .where(eq(localImageUploadTable.filename, second))
    )[0].state,
  ).toBe("installed");
});

it("verifies every receipt after the entire completion batch", async () => {
  await reference("second", second);
  const before = await db.select().from(localImageUploadTable);
  await db.run(
    sql.raw(`CREATE TRIGGER rewrite_earlier AFTER UPDATE ON local_image_upload
  WHEN NEW.filename='${second}' AND OLD.state='installed' AND NEW.state='completed'
  BEGIN UPDATE local_image_upload SET sha256=printf('%064d',0) WHERE filename='${first}'; END`),
  );
  await expect(complete()).rejects.toThrow("completion");
  expect(await db.select().from(localImageUploadTable)).toEqual(before);
});

it.each(["created_at", "installed_at"])(
  "refuses changed %s REAL bits even when SQLite text formatting stays the same",
  async (field) => {
    await db.run(
      sql.raw(
        `UPDATE local_image_upload SET ${field}=1.0000000000000002 WHERE filename='${first}'`,
      ),
    );
    const before = await timestamps();
    await db.run(
      sql.raw(`CREATE TRIGGER rewrite_real AFTER UPDATE ON local_image_upload
  WHEN OLD.state='installed' AND NEW.state='completed'
  BEGIN UPDATE local_image_upload SET ${field}=1.0000000000000004 WHERE filename=NEW.filename; END`),
    );
    await expect(complete()).rejects.toThrow("completion");
    expect(await timestamps()).toEqual(before);
  },
);

it("preserves a large imported pending pin set while completing a linked image", async () => {
  await db.run(
    sql.raw(`WITH RECURSIVE pins(n) AS (SELECT 100 UNION ALL SELECT n+1 FROM pins WHERE n<1199)
    INSERT INTO local_image_upload(filename,byte_length,sha256,state,created_at)
    SELECT printf('00000000-0000-4000-8000-%012d.svg',n),1,printf('%064d',0),'pending',1 FROM pins`),
  );
  const before = await db.values(
    sql`SELECT * FROM local_image_upload WHERE state='pending' ORDER BY filename`,
  );
  await complete();
  expect(
    await db.values(sql`SELECT * FROM local_image_upload WHERE state='pending' ORDER BY filename`),
  ).toEqual(before);
  expect(
    (
      await db
        .select({ state: localImageUploadTable.state })
        .from(localImageUploadTable)
        .where(eq(localImageUploadTable.filename, first))
    )[0].state,
  ).toBe("completed");
});

it("rolls back completion if a trigger introduces another referenced installation", async () => {
  const before = await db.select().from(localImageUploadTable);
  const cards = await db.select().from(cardTable);
  const late = "00000000-0000-4000-8000-000000000004.svg";
  await db.run(
    sql.raw(`CREATE TRIGGER extend_selection AFTER UPDATE ON local_image_upload
    WHEN OLD.state='installed' AND NEW.state='completed' BEGIN
    INSERT INTO local_image_upload(filename,byte_length,sha256,state,created_at,installed_at)
    VALUES('${late}',3,'${"a".repeat(64)}','installed',1,2);
    INSERT INTO card(id,partition_id,layer_id,content)
    VALUES('late','${partitionId}','${layerId}','kozane-image:/api/images/${late}'); END`),
  );
  await expect(complete()).rejects.toThrow("completion selection changed");
  expect(await db.select().from(localImageUploadTable)).toEqual(before);
  expect(await db.select().from(cardTable)).toEqual(cards);
});

it("leaves unreferenced installations and referenced pending pins protected", async () => {
  await reference("pending", pending);
  await complete();
  const rows = await db.select().from(localImageUploadTable);
  expect(rows.find((row) => row.filename === first)).toMatchObject({
    state: "completed",
    completedAt: expect.any(Date),
  });
  expect(rows.find((row) => row.filename === second)).toMatchObject({
    state: "installed",
    completedAt: null,
  });
  expect(rows.find((row) => row.filename === pending)).toMatchObject({
    state: "pending",
    installedAt: null,
  });
  const before = await db.select().from(localImageUploadTable);
  await complete();
  expect(await db.select().from(localImageUploadTable)).toEqual(before);
});
