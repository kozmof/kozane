import { afterEach, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  decodeRecovery,
  RECOVERY_DB_MAX_BYTES,
} from "../../../../../scripts/restoration-harness/recovery";
import { createHash } from "node:crypto";
import { lockedDriver } from "../../../../../scripts/compatibility/locked-driver.mjs";
import { prepareBrowserCorpus } from "../../../../../scripts/compatibility/prepare-browser.mjs";
import { readCorpus } from "../../../../../scripts/compatibility/read-corpus.mjs";
import { summarizeView } from "../../../../../scripts/compatibility/view-summary";
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function copy() {
  const root = mkdtempSync(join(tmpdir(), "kozane-corpus-test-"));
  temporary.push(root);
  cpSync(resolve("tests/compatibility/corpus"), root, { recursive: true });
  return root;
}
it("validates retained producers, original bytes and recorded outcomes", () => {
  const cohorts = readCorpus(resolve("tests/compatibility/corpus"));
  expect(cohorts.length).toBeGreaterThan(0);
  expect(
    cohorts[0].fixtures.flatMap((fixture: { expected: unknown[] }) => fixture.expected),
  ).toHaveLength(11);
});
it.each(["manifest.json", "producer.tgz", "sole.sqlite3"])(
  "rejects altered retained %s bytes",
  (file) => {
    const root = copy();
    const path = join(root, "core-0.1.0-rc1-wasm", file);
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(path, bytes);
    expect(() => readCorpus(root)).toThrow(/changed/);
  },
);
it("rejects fixture path traversal even with an updated manifest hash", () => {
  const root = copy();
  const indexPath = join(root, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const path = join(root, index.cohorts[0].id, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.fixtures[0].file = "../outside.sqlite3";
  const bytes = JSON.stringify(manifest);
  writeFileSync(path, bytes);
  index.cohorts[0].sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(indexPath, JSON.stringify(index));
  expect(() => readCorpus(root)).toThrow(/fixture filename/);
});
function selected() {
  return {
    kind: "selected",
    namespaceId: "n",
    snapshot: {
      namespace: { id: "n", name: "日本語", isDefault: false },
      snapshot: {
        cards: [
          { id: "a", content: "One", createdAt: new Date(0) },
          { id: "b", content: "Two" },
        ],
        partitions: [],
        layers: [],
        scopes: [],
        scopeRels: [],
        glueRels: [],
      },
    },
  };
}
it("ignores row ordering and added derived fields but detects changed stored content", async () => {
  const before = selected();
  const expected = await summarizeView(before);
  const after = selected();
  after.snapshot.snapshot.cards.reverse();
  Object.assign(after.snapshot.snapshot.cards[0], { futureDerived: "new DTO field" });
  expect(await summarizeView(after)).toEqual(expected);
  after.snapshot.snapshot.cards[0].content = "Changed";
  expect((await summarizeView(after)).dataHash).not.toBe(expected.dataHash);
});

it("prepares browser assets from unchanged retained bytes and expectations", () => {
  const root = resolve("tests/compatibility/corpus");
  const output = mkdtempSync(join(tmpdir(), "kozane-browser-corpus-test-"));
  temporary.push(output);
  const fixtures = prepareBrowserCorpus(root, output);
  const catalog = JSON.parse(readFileSync(join(output, "corpus.json"), "utf8"));
  expect(catalog).toEqual({ format: 1, fixtures });
  for (const fixture of fixtures) {
    const bytes = readFileSync(join(output, fixture.url.slice(1)));
    expect(bytes.length).toBe(fixture.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
    const original = readCorpus(root).find((cohort) => cohort.id === fixture.cohort);
    expect(
      original.fixtures.find((item: { id: string }) => item.id === fixture.id).expected,
    ).toEqual(fixture.expected);
  }
});
it("refuses to prepare a browser corpus from altered original bytes", () => {
  const root = copy();
  const output = mkdtempSync(join(tmpdir(), "kozane-browser-corpus-test-"));
  temporary.push(output);
  writeFileSync(join(root, "core-0.1.0-rc1-wasm", "empty.sqlite3"), "damaged");
  expect(() => prepareBrowserCorpus(root, output)).toThrow(/Retained fixture changed/);
});

it("retains both supported producer engines and eleven outcomes per cohort", () => {
  const cohorts = readCorpus(resolve("tests/compatibility/corpus"));
  expect(new Set(cohorts.map((cohort) => cohort.producer.driver.package))).toEqual(
    new Set(["@sqlite.org/sqlite-wasm", "@libsql/client"]),
  );
  for (const id of ["core-0.1.0-rc1-wasm", "core-0.1.0-rc2-libsql"]) {
    const cohort = cohorts.find((entry) => entry.id === id);
    expect(cohort).toBeDefined();
    expect(
      cohort.fixtures.flatMap((fixture: { expected: unknown[] }) => fixture.expected),
    ).toHaveLength(11);
  }
});
it("selects the complete locked native driver graph without unrelated workspace packages", () => {
  const lock = readFileSync("pnpm-lock.yaml", "utf8");
  const version = JSON.parse(
    readFileSync("node_modules/@libsql/client/package.json", "utf8"),
  ).version;
  const root = `@libsql/client@${version}`;
  const graph = lockedDriver(lock, root);
  expect(graph.packages).toContain("integrity:");
  expect(graph.snapshots).toMatch(/'@libsql\/linux-x64-gnu@[^']+':/);
  expect(graph.snapshots).toMatch(/'@libsql\/darwin-arm64@[^']+':/);
  expect(graph.snapshots).toMatch(/undici-types@[^:]+:/);
  expect(graph.snapshots).not.toContain("svelte");
  expect(() => lockedDriver(lock, "missing-driver@1.0.0")).toThrow(/Missing driver snapshot/);
  expect(() =>
    lockedDriver(
      lock.replace(
        /  libsql@[^:\n]+:\n    resolution:/,
        "  missing-libsql@0.0.0:\n    resolution:",
      ),
      root,
    ),
  ).toThrow(/Missing driver artifact/);
});

it.each(["core-0.1.0-rc3-wasm-boundaries", "core-0.1.0-rc4-libsql-boundaries"])(
  "retains a valid recovery-limit database and accepted schema formatting from %s",
  (id) => {
    const root = resolve("tests/compatibility/corpus");
    const cohort = readCorpus(root).find((entry) => entry.id === id);
    expect(cohort).toBeDefined();
    const limitPath = join(cohort.directory, "recovery-limit.sqlite3");
    const bytes = readFileSync(limitPath);
    expect(bytes.length).toBe(RECOVERY_DB_MAX_BYTES);
    const envelope = JSON.stringify({
      schemaVersion: cohort.migrationId,
      savedAt: 0,
      db: bytes.toString("base64"),
    });
    expect(Buffer.from(decodeRecovery(envelope, cohort.migrationId).bytes).equals(bytes)).toBe(
      true,
    );
    const oversized = JSON.stringify({
      schemaVersion: cohort.migrationId,
      savedAt: 0,
      db: Buffer.concat([bytes, Buffer.from([0])]).toString("base64"),
    });
    expect(() => decodeRecovery(oversized, cohort.migrationId)).toThrow(
      expect.objectContaining({ reason: "size" }),
    );
    const limit = new DatabaseSync(limitPath, { readOnly: true });
    const normalized = new DatabaseSync(join(cohort.directory, "normalized-schema.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(limit.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(
        Number(limit.prepare("SELECT count(*) AS count FROM card").get()!.count),
      ).toBeGreaterThan(100);
      expect(normalized.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(
        Number(
          normalized
            .prepare(
              "SELECT count(*) AS count FROM sqlite_schema WHERE sql LIKE '%retained corpus formatting%'",
            )
            .get()!.count,
        ),
      ).toBeGreaterThan(1);
      expect(
        normalized.prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_stat1'").get(),
      ).toEqual({ name: "sqlite_stat1" });
    } finally {
      limit.close();
      normalized.close();
    }
  },
);
