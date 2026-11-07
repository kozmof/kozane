import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import {
  normalizeSchemaSql,
  schemaManifest,
} from "../../../../scripts/browser-spike/schema-manifest.js";

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

it.each([
  ["declared type", "CREATE TABLE x(a TEXT)", "CREATE TABLE x(a INTEGER)"],
  ["nullability", "CREATE TABLE x(a TEXT)", "CREATE TABLE x(a TEXT NOT NULL)"],
  [
    "default literal",
    "CREATE TABLE x(a TEXT DEFAULT 'a b')",
    "CREATE TABLE x(a TEXT DEFAULT 'ab')",
  ],
  [
    "primary key order",
    "CREATE TABLE x(a,b,PRIMARY KEY(a,b))",
    "CREATE TABLE x(a,b,PRIMARY KEY(b,a))",
  ],
  ["check expression", "CREATE TABLE x(a CHECK(a>0))", "CREATE TABLE x(a CHECK(a>=0))"],
  ["uniqueness", "CREATE TABLE x(a UNIQUE)", "CREATE TABLE x(a)"],
  [
    "foreign key action",
    "CREATE TABLE x(a REFERENCES y(id) ON DELETE CASCADE)",
    "CREATE TABLE x(a REFERENCES y(id) ON DELETE RESTRICT)",
  ],
  [
    "index order",
    "CREATE TABLE x(a,b);CREATE INDEX ix ON x(a,b)",
    "CREATE TABLE x(a,b);CREATE INDEX ix ON x(b,a)",
  ],
  [
    "index direction",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a ASC)",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a DESC)",
  ],
  [
    "partial predicate",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a) WHERE a>0",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a) WHERE a>=0",
  ],
  [
    "view expression",
    "CREATE TABLE x(a);CREATE VIEW v AS SELECT a+1 FROM x",
    "CREATE TABLE x(a);CREATE VIEW v AS SELECT a+2 FROM x",
  ],
  [
    "trigger behavior",
    "CREATE TABLE x(a);CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET a=1;END",
    "CREATE TABLE x(a);CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET a=2;END",
  ],
  ["unexpected object", "CREATE TABLE x(a)", "CREATE TABLE x(a);CREATE TABLE extra(a)"],
])("detects changed %s", async (_case, original, altered) => {
  const clients = [createClient({ url: ":memory:" }), createClient({ url: ":memory:" })];
  try {
    await clients[0].executeMultiple(original);
    await clients[1].executeMultiple(altered);
    const manifests = await Promise.all(
      clients.map((client) =>
        schemaManifest(async (sql) =>
          (await client.execute(sql)).rows.map((row) => Array.from(row)),
        ),
      ),
    );
    expect(manifests[0]).not.toEqual(manifests[1]);
  } finally {
    for (const client of clients) client.close();
  }
});

it("accepts formatting variants and ignores SQLite runtime statistics", async () => {
  const clients = [createClient({ url: ":memory:" }), createClient({ url: ":memory:" })];
  try {
    await clients[0].executeMultiple(
      "CREATE TABLE x(a TEXT DEFAULT 'a b' CHECK(length(a)>0)); CREATE INDEX ix ON x(a);",
    );
    await clients[1].executeMultiple(
      "CREATE TABLE x ( a TEXT DEFAULT 'a b' CHECK ( length ( a ) > 0 ) ); CREATE INDEX ix ON x ( a ); ANALYZE;",
    );
    const manifests = await Promise.all(
      clients.map((client) =>
        schemaManifest(async (sql) =>
          (await client.execute(sql)).rows.map((row) => Array.from(row)),
        ),
      ),
    );
    expect(manifests[0]).toEqual(manifests[1]);
  } finally {
    for (const client of clients) client.close();
  }
});
