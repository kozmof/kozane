import { afterEach, describe, expect, it, vi } from "vitest";
import { addProject } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";
import { addLayer } from "../../db/api/layer.js";
import { addCard } from "../../db/api/card.js";
import { createTestDB } from "../../test-utils/db.js";
import type { DB } from "../../db/tx.js";
import { shortId } from "./short-id.js";
import { printCards, type PrintableCard } from "./card-print.js";

/** What was written to stdout, one entry per line printed. */
function captureLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Here" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  return { db, projectId, bundleId };
}

function printable(id: string, overrides: Partial<PrintableCard> = {}): PrintableCard {
  return { id, bundle: "General", content: "Alpha", posX: 24, posY: 48, ...overrides };
}

/** The line `printCards` writes for one card, with its id abbreviated as the CLI prints it. */
async function lineFor(db: DB, cards: PrintableCard[], column?: (c: PrintableCard) => string) {
  const log = captureLog();
  await printCards(db, cards, column);
  return log.mock.calls.map(([line]) => String(line));
}

describe("printCards", () => {
  it("says so rather than printing nothing at all", async () => {
    const { db } = await setup();
    expect(await lineFor(db, [])).toEqual(["No cards found."]);
  });

  it("prints id, bundle, position and text", async () => {
    const { db, bundleId } = await setup();
    const id = await addCard({ db, bundleId, content: "Alpha" });

    const [line] = await lineFor(db, [printable(id)]);

    expect(line).toBe(`${shortId(id, [id])}  General  (24, 48)  Alpha`);
  });

  it("puts an extra column between the position and the text when asked for one", async () => {
    const { db, bundleId } = await setup();
    const id = await addCard({ db, bundleId, content: "Alpha" });

    const [line] = await lineFor(db, [printable(id)], () => "12px");

    expect(line).toBe(`${shortId(id, [id])}  General  (24, 48)  12px  Alpha`);
  });

  it("keeps a multi-line card on one line", async () => {
    // A listing is one row per card, so a card holding newlines must not become three rows
    // that read as three cards.
    const { db, bundleId } = await setup();
    const id = await addCard({ db, bundleId, content: "one\ntwo" });

    const [line] = await lineFor(db, [printable(id, { content: "one\r\ntwo\nthree" })]);

    expect(line).toContain("one two three");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("abbreviates against every card in the workspace, not the ones being printed", async () => {
    // The id printed for a card is the one `kozane card show` takes whichever command
    // printed it, which is only true if the abbreviation is drawn against the whole set.
    const { db, bundleId } = await setup();
    const shown = await addCard({ db, bundleId, content: "Shown" });
    const hidden = await addCard({ db, bundleId, content: "Hidden" });

    const [line] = await lineFor(db, [printable(shown)]);

    expect(line.split("  ")[0]).toBe(shortId(shown, [shown, hidden]));
  });
});
