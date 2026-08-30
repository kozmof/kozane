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
 * Each card's id is its text, so a failure names the card it is about, and the ids order
 * the same way `sortCards` breaks a tie on them.
 */
const THREE_CARDS = [
  { content: "oldest", created: "2026-01-01T00:00:00Z", updated: "2026-04-01T00:00:00Z" },
  { content: "reconsidered", created: "2026-02-01T00:00:00Z", updated: "2026-03-01T00:00:00Z" },
  { content: "untouched", created: "2026-03-01T00:00:00Z", updated: "2026-03-01T00:00:00Z" },
] as const;

/** The three orders `THREE_CARDS` produces, as `card list` prints them. */
const BY_CREATED = [
  "2026-01-01T00:00:00Z  oldest",
  "2026-02-01T00:00:00Z  reconsidered",
  "2026-03-01T00:00:00Z  untouched",
];
const BY_UPDATED = [
  "2026-03-01T00:00:00Z  reconsidered",
  "2026-03-01T00:00:00Z  untouched",
  "2026-04-01T00:00:00Z  oldest",
];
const BY_GAP = ["0s  untouched", "28d  reconsidered", "90d  oldest"];

/**
 * Writes `THREE_CARDS` into an initialised workspace, optionally tied to a taskspace.
 *
 * Inserted directly rather than through `kozane card add`. Each CLI call here is a `node
 * --import tsx` spawn of several seconds, and the histories these cards need would have to
 * be written over the top of whatever `card add` stamped anyway — so the spawns would buy
 * nothing but the flakiness of a test that starts eight processes. What the command under
 * test reads is the table, and this puts the table in a known state. `taskspace_id` is
 * written the same way for the same reason: the CLI has no command that sets it, since a
 * card is tied to a taskspace by the board rather than from a terminal.
 */
async function seedThreeCards(root: string, taskspaceId: string | null = null): Promise<void> {
  await withDb(root, async (client) => {
    const [bundle, layer] = await Promise.all([
      client.execute("SELECT id FROM bundle LIMIT 1"),
      client.execute("SELECT id FROM layer LIMIT 1"),
    ]);
    const bundleId = bundle.rows[0].id as string;
    const layerId = layer.rows[0].id as string;
    await client.batch(
      THREE_CARDS.map(({ content, created, updated }) => ({
        sql: `INSERT INTO card (id, bundle_id, layer_id, taskspace_id, content, pos_x, pos_y, z_index, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
        args: [
          content,
          bundleId,
          layerId,
          taskspaceId,
          content,
          seconds(created),
          seconds(updated),
        ],
      })),
      "write",
    );
  });
}

/** Puts every card of the workspace in one scope, which is what a scoped taskspace lists. */
async function addEveryCardToScope(root: string, scopeId: string): Promise<void> {
  await withDb(root, async (client) => {
    await client.execute({
      sql: "INSERT INTO scope_rel (scope_id, card_id) SELECT ?, id FROM card",
      args: [scopeId],
    });
  });
}

/**
 * The id of the one row in `table`, read from the database rather than from what the
 * command printed: the CLI prints short ids, which resolve as arguments but are not what
 * a foreign key wants.
 */
async function onlyId(root: string, table: "scope" | "taskspace"): Promise<string> {
  let id = "";
  await withDb(root, async (client) => {
    const rows = await client.execute(`SELECT id FROM ${table}`);
    if (rows.rows.length !== 1)
      throw new Error(`Expected one ${table} row, found ${rows.rows.length}`);
    id = rows.rows[0].id as string;
  });
  return id;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("kozane card list --sort", () => {
  it("orders by each key, and reverses", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    await seedThreeCards(root);

    expect(listed(root, "--sort", "created")).toEqual(BY_CREATED);
    expect(listed(root, "--sort", "updated")).toEqual(BY_UPDATED);
    // Neither of the orders above: the card never edited comes first and the one that stood
    // longest before being rewritten comes last.
    expect(listed(root, "--sort", "gap")).toEqual(BY_GAP);
    expect(listed(root, "--sort", "gap", "--reverse")).toEqual([...BY_GAP].reverse());
  }, 90_000);

  it("prints the listing unchanged when no sort is asked for", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    await seedThreeCards(root);

    // No time column: `<id>  <bundle>  (<x>, <y>)  <text>` is what it has always printed,
    // and what everything parsing this output expects.
    expect(listed(root).toSorted()).toEqual(["oldest", "reconsidered", "untouched"]);
  }, 90_000);

  /**
   * The scope path: `card list` run in a taskspace directory lists that taskspace's scope
   * members, through a different query from the project listing — one that selects the card
   * columns wholesale rather than naming them. It has to sort and print identically, which
   * is the claim `ordered` and `timeColumn` in `cardList` are there to make true.
   */
  it("sorts a scoped taskspace listing the way it sorts a project listing", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "scope", "add", "Sort scope");
    const scopeId = await onlyId(root, "scope");
    await seedThreeCards(root);
    await addEveryCardToScope(root, scopeId);
    cli(root, "taskspace", "create", "reading", "--scope", scopeId);
    const taskspaceDir = join(root, "reading");

    expect(listed(taskspaceDir, "--sort", "gap")).toEqual(BY_GAP);
    expect(listed(taskspaceDir, "--sort", "created", "--reverse")).toEqual(
      [...BY_CREATED].reverse(),
    );
    // And the column is still absent when nothing asked for it.
    expect(listed(taskspaceDir).toSorted()).toEqual(["oldest", "reconsidered", "untouched"]);
  }, 120_000);

  /**
   * The third path: a taskspace with no scope lists the cards tied directly to it, and says
   * so on stderr. Sorted by the same comparator, out of a third query.
   */
  it("sorts the cards tied directly to a taskspace that has no scope", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "taskspace", "create", "loose", "--no-scope");
    await seedThreeCards(root, await onlyId(root, "taskspace"));
    const taskspaceDir = join(root, "loose");

    expect(listed(taskspaceDir, "--sort", "updated")).toEqual(BY_UPDATED);
    expect(listed(taskspaceDir, "--sort", "gap", "--reverse")).toEqual([...BY_GAP].reverse());
  }, 120_000);

  /**
   * The whole of stderr, not a substring of it.
   *
   * These two refusals are raised before `runWorkspaceCommand`, which is the one place the
   * CLI turns a throw into a one-line message and an exit code. A throw from outside it
   * reaches the user as an unhandled rejection: the message is still in there, so an
   * assertion that merely looked for the message would pass on a stack trace naming a line
   * of `card.ts`. Matching the whole stream is what tells the two apart.
   */
  function refusal(root: string, ...args: string[]): string {
    const result = runCli(root, ...args);
    expect(result.status).toBe(1);
    return result.stderr.trim();
  }

  it("refuses an unknown key and a --reverse with nothing to reverse", () => {
    const root = tempWorkspace();
    cli(root, "init");

    expect(refusal(root, "card", "list", "--sort", "bogus")).toContain(
      "Must be one of: created, updated, gap.",
    );
    expect(refusal(root, "card", "list", "--reverse")).toBe("Error: --reverse requires --sort.");
  }, 60_000);

  it("refuses a --taskspace combined with --project the same way", () => {
    const root = tempWorkspace();
    cli(root, "init");

    expect(refusal(root, "card", "list", "--taskspace", ".", "--project", "abc")).toBe(
      "Error: --taskspace cannot be combined with --project or --bundle.",
    );
  }, 60_000);

  it("names the malformed argument outside a workspace, rather than the missing workspace", () => {
    // Nothing about `--reverse` alone depends on there being a workspace to list, so the
    // command is refused where it is typed rather than after a workspace lookup that was
    // never going to make it valid.
    const root = tempWorkspace();

    expect(refusal(root, "card", "list", "--reverse")).toBe("Error: --reverse requires --sort.");
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

  /**
   * The one way a card can carry a history it never had. Migration 0011 had to give both
   * columns a literal `DEFAULT 0` to add them NOT NULL, and SQLite cannot drop a column
   * default afterwards — so an `INSERT INTO card` naming neither column succeeds at the
   * epoch instead of failing. Nothing in the app writes such a row; hand-written SQL against
   * the workspace database does, and `doctor` is where that should be visible.
   */
  it("reports a card left at the epoch by an insert that named neither column", async () => {
    const root = tempWorkspace();
    cli(root, "init");

    expect(cli(root, "doctor")).toContain("✓  Card timestamps valid");

    await withDb(root, async (client) => {
      const [bundle, layer] = await Promise.all([
        client.execute("SELECT id FROM bundle LIMIT 1"),
        client.execute("SELECT id FROM layer LIMIT 1"),
      ]);
      await client.execute({
        sql: `INSERT INTO card (id, bundle_id, layer_id, content, pos_x, pos_y, z_index)
              VALUES ('epoch', ?, ?, 'inserted by hand', 0, 0, 0)`,
        args: [bundle.rows[0].id, layer.rows[0].id],
      });
    });

    const result = runCli(root, "doctor");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "✗  Card timestamps valid — 1 card stamped outside what this app writes",
    );
    // And the listing it warns about does read 1970, which is what makes it worth reporting.
    expect(listed(root, "--sort", "created")).toContain("1970-01-01T00:00:00Z  inserted by hand");
  }, 90_000);

  /**
   * The other end of the same hole. The columns are plain integers, so a hand-written
   * `INSERT` can put a number in them that no `Date` can represent — and `toISOString`
   * throws `RangeError: Invalid time value` on such a date. That reached the user as one
   * line of error in place of the listing: every sound card in the project hidden in order
   * to report a problem with one of them.
   */
  it("lists a card whose timestamp no date can be read from, and reports it", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    await seedThreeCards(root);

    await withDb(root, async (client) => {
      await client.execute({
        sql: "UPDATE card SET created_at = ?, updated_at = ? WHERE id = 'untouched'",
        args: [9_000_000_000_000_000, 9_000_000_000_000_000],
      });
    });

    // The whole listing still prints, and the card that cannot be placed is last and says so.
    expect(listed(root, "--sort", "created")).toEqual([
      "2026-01-01T00:00:00Z  oldest",
      "2026-02-01T00:00:00Z  reconsidered",
      "invalid  untouched",
    ]);
    // `gap` too, where the unreadable value would otherwise have read as an honest `0s`.
    expect(listed(root, "--sort", "gap")).toEqual([
      "28d  reconsidered",
      "90d  oldest",
      "invalid  untouched",
    ]);
    // Carried along by --reverse like every other tie, rather than pinned to the end.
    expect(listed(root, "--sort", "created", "--reverse")[0]).toBe("invalid  untouched");

    const result = runCli(root, "doctor");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "✗  Card timestamps valid — 1 card stamped outside what this app writes",
    );
  }, 90_000);
});

describe("kozane card show --times", () => {
  it("prints the three values --sort orders by, above the text", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    await seedThreeCards(root);

    expect(cli(root, "card", "show", "reconsidered", "--times")).toBe(
      [
        "created  2026-02-01T00:00:00Z",
        "updated  2026-03-01T00:00:00Z",
        "gap      28d",
        "",
        "reconsidered",
        "",
      ].join("\n"),
    );
  }, 90_000);

  it("prints the text and nothing else without the flag", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    await seedThreeCards(root);

    // What `kozane card show x > f.txt` writes. A history printed by default would land in
    // the file too, so the flag is the whole of the difference.
    expect(cli(root, "card", "show", "reconsidered")).toBe("reconsidered\n");
  }, 90_000);

  it("says invalid for a timestamp no date can be read from, as the listing does", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    await seedThreeCards(root);
    await withDb(root, async (client) => {
      await client.execute({
        sql: "UPDATE card SET created_at = ?, updated_at = ? WHERE id = 'oldest'",
        args: [9_000_000_000_000_000, 9_000_000_000_000_000],
      });
    });

    expect(cli(root, "card", "show", "oldest", "--times")).toBe(
      ["created  invalid", "updated  invalid", "gap      invalid", "", "oldest", ""].join("\n"),
    );
  }, 90_000);
});
