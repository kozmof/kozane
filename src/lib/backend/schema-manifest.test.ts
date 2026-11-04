import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { normalizeSchemaSql, schemaManifest } from "../../../scripts/browser-spike/schema-manifest";

it("ignores whitespace and comments while preserving literals and operators", () => {
  expect(normalizeSchemaSql("CREATE TABLE x(a TEXT CHECK(a != 'a b'));")).toEqual(
    normalizeSchemaSql("CREATE /* comment */ TABLE x ( a TEXT CHECK ( a != 'a b' ) )"),
  );
  expect(normalizeSchemaSql("a != 'a b'")).not.toEqual(normalizeSchemaSql("a = 'ab'"));
  expect(normalizeSchemaSql('"A B"')).not.toEqual(normalizeSchemaSql('"AB"'));
});

it("detects schema changes without modifying either database", async () => {
  const left = createClient({ url: ":memory:" });
  const right = createClient({ url: ":memory:" });
  const inspect = (client: typeof left) =>
    schemaManifest(async (sql) => (await client.execute(sql)).rows.map((row) => Array.from(row)));
  try {
    for (const client of [left, right]) {
      await client.executeMultiple(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER, parent INTEGER REFERENCES parent(id), label TEXT DEFAULT 'a b' CHECK(length(label)>0), UNIQUE(id,parent)); CREATE INDEX child_partial ON child(label DESC, id) WHERE id > 0; CREATE VIEW labels AS SELECT label FROM child; CREATE TRIGGER child_log AFTER INSERT ON child BEGIN UPDATE child SET label = 'updated' WHERE id = new.id; END;",
      );
    }
    const before = await left.execute("SELECT * FROM sqlite_schema ORDER BY name");
    const expected = await inspect(left);
    expect(await inspect(right)).toEqual(expected);
    await right.execute("DROP INDEX child_partial");
    expect(await inspect(right)).not.toEqual(expected);
    expect((await left.execute("SELECT * FROM sqlite_schema ORDER BY name")).rows).toEqual(
      before.rows,
    );
  } finally {
    left.close();
    right.close();
  }
});
