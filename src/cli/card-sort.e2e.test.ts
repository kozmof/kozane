import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `kozane card list --sort` end to end, over a real workspace built by `kozane init`.
 *
 * The histories are written rather than waited for. The columns are stored to the second,
 * so cards added one after another may or may not straddle a second boundary — an order
 * that depends on how fast the machine is is not an order worth asserting. Written, the
 * fixture states the history and the assertions state the order it produces.
 */

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

/**
 * The `when` of migration 0011, read out of the journal rather than copied from it, so
 * regenerating a migration cannot leave this test rolling a workspace back to the wrong
 * point and still passing for the wrong reason.
 */
const CARD_TIMESTAMPS_MIGRATION_WHEN = migrationWhen("0011_card_timestamps");

function migrationWhen(tag: string): number {
  const journal = JSON.parse(readFileSync(resolve("drizzle/meta/_journal.json"), "utf-8")) as {
    entries: { tag: string; when: number }[];
  };
  const entry = journal.entries.find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`No migration tagged ${tag} in drizzle/meta/_journal.json`);
  return entry.when;
}

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-card-sort-e2e-"));
  tempRoots.push(root);
  return root;
}

function runCli(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir(), NO_COLOR: "1" },
  });
}

function cli(cwd: string, ...args: string[]): string {
  const result = runCli(cwd, ...args);
  if (result.status !== 0) {
    throw new Error(
      [`kozane ${args.join(" ")} failed (${result.status})`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

/** The card text of each printed line, which is what names a card in these fixtures. */
function listed(root: string, ...args: string[]): string[] {
  return cli(root, "card", "list", ...args)
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\S+\s{2}\S+\s{2}\(-?\d+, -?\d+\)\s{2}(.*)$/);
      return match ? [match[1]] : [];
    });
}

const seconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

async function withDb(
  root: string,
  run: (client: ReturnType<typeof createClient>) => Promise<void>,
) {
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    await run(client);
  } finally {
    client.close();
  }
}

/**
 * Three cards on which no two of the orders agree: `oldest` was added first but rewritten
 * most recently, `untouched` was added last and never edited, and `reconsidered` sits
 * between them by both timestamps while holding much the longest interval.
 *
 * Inserted directly rather than through `kozane card add`. Each CLI call here is a `node
 * --import tsx` spawn of several seconds, and the histories these cards need would have to
 * be written over the top of whatever `card add` stamped anyway — so the spawns would buy
 * nothing but the flakiness of a test that starts eight processes. What the command under
 * test reads is the table, and this puts the table in a known state.
 */
async function seedThreeCards(root: string): Promise<void> {
  cli(root, "init");
  await withDb(root, async (client) => {
    const [bundle, layer] = await Promise.all([
      client.execute("SELECT id FROM bundle LIMIT 1"),
      client.execute("SELECT id FROM layer LIMIT 1"),
    ]);
    const bundleId = bundle.rows[0].id as string;
    const layerId = layer.rows[0].id as string;
    await client.batch(
      [
        { content: "oldest", created: "2026-01-01T00:00:00Z", updated: "2026-04-01T00:00:00Z" },
        {
          content: "reconsidered",
          created: "2026-02-01T00:00:00Z",
          updated: "2026-03-01T00:00:00Z",
        },
        { content: "untouched", created: "2026-03-01T00:00:00Z", updated: "2026-03-01T00:00:00Z" },
      ].map(({ content, created, updated }) => ({
        sql: `INSERT INTO card (id, bundle_id, layer_id, content, pos_x, pos_y, z_index, created_at, updated_at)
              VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`,
        args: [content, bundleId, layerId, content, seconds(created), seconds(updated)],
      })),
      "write",
    );
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("kozane card list --sort", () => {
  it("orders by each key, and reverses", async () => {
    const root = tempWorkspace();
    await seedThreeCards(root);

    expect(listed(root, "--sort", "created")).toEqual([
      "2026-01-01T00:00:00Z  oldest",
      "2026-02-01T00:00:00Z  reconsidered",
      "2026-03-01T00:00:00Z  untouched",
    ]);
    expect(listed(root, "--sort", "updated")).toEqual([
      "2026-03-01T00:00:00Z  reconsidered",
      "2026-03-01T00:00:00Z  untouched",
      "2026-04-01T00:00:00Z  oldest",
    ]);
    // Neither of the orders above: the card never edited comes first and the one that stood
    // longest before being rewritten comes last.
    expect(listed(root, "--sort", "gap")).toEqual([
      "0s  untouched",
      "28d  reconsidered",
      "90d  oldest",
    ]);
    expect(listed(root, "--sort", "gap", "--reverse")).toEqual([
      "90d  oldest",
      "28d  reconsidered",
      "0s  untouched",
    ]);
  }, 90_000);

  it("prints the listing unchanged when no sort is asked for", async () => {
    const root = tempWorkspace();
    await seedThreeCards(root);

    // No time column: `<id>  <bundle>  (<x>, <y>)  <text>` is what it has always printed,
    // and what everything parsing this output expects.
    expect(listed(root).toSorted()).toEqual(["oldest", "reconsidered", "untouched"]);
  }, 90_000);

  it("refuses an unknown key and a --reverse with nothing to reverse", () => {
    const root = tempWorkspace();
    cli(root, "init");

    expect(runCli(root, "card", "list", "--sort", "bogus")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Must be one of: created, updated, gap."),
    });
    expect(runCli(root, "card", "list", "--reverse")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("--reverse requires --sort."),
    });
  }, 60_000);

  it("backfills cards that predate the timestamp columns", async () => {
    const root = tempWorkspace();
    cli(root, "init");

    // Roll the workspace back to 0010 — drop the two columns and the journal row that says
    // they were added — and write the card there, so it genuinely predates them the way a
    // card in an upgraded workspace does. `db migrate` then re-applies 0011 over a row with
    // no history at all.
    await withDb(root, async (client) => {
      await client.batch(
        [
          "ALTER TABLE card DROP COLUMN created_at",
          "ALTER TABLE card DROP COLUMN updated_at",
          `DELETE FROM __drizzle_migrations WHERE created_at >= ${CARD_TIMESTAMPS_MIGRATION_WHEN}`,
        ],
        "write",
      );
      const [bundle, layer] = await Promise.all([
        client.execute("SELECT id FROM bundle LIMIT 1"),
        client.execute("SELECT id FROM layer LIMIT 1"),
      ]);
      await client.execute({
        sql: `INSERT INTO card (id, bundle_id, layer_id, content, pos_x, pos_y, z_index)
              VALUES ('old', ?, ?, ?, 0, 0, 0)`,
        args: [bundle.rows[0].id, layer.rows[0].id, "written before the columns existed"],
      });
    });
    expect(runCli(root, "db", "status")).toMatchObject({
      status: 1,
      stdout: expect.stringContaining("Status  : pending"),
    });

    expect(cli(root, "db", "migrate")).toContain("Database migrated.");

    // Backfilled to the moment the migration ran, so the card reads as never since edited
    // rather than as created at the epoch.
    expect(listed(root, "--sort", "gap")).toEqual(["0s  written before the columns existed"]);
    const [line] = listed(root, "--sort", "created");
    const createdAt = new Date(line.split("  ")[0]);
    expect(createdAt.getTime()).toBeGreaterThan(Date.now() - 10 * 60_000);
  }, 90_000);
});
