import { describe, it, expect } from "vitest";
import {
  createTestDB,
  isTooManyVariables,
  seedCards,
  SQLITE_VARIABLE_MAX,
} from "../../test-utils/db.js";
import {
  addScopeRel,
  addScopeRels,
  removeScopeRel,
  getAllCardsByScope,
  getCardsByScopeWithPartitionName,
  addScopeMembers,
  removeScopeMembers,
  removeScopeMembersFromNamespace,
  getScopeRelsByCards,
  getScopeRelsByNamespace,
} from "./scope-rel.js";
import { addNamespace } from "./namespace.js";
import { addPartition } from "./partition.js";
import { addCard } from "./card.js";
import { addScope } from "./scope.js";
import { NotFoundError } from "./utils.js";
import { addLayer, getDefaultLayer } from "./layer.js";
import { INSERT_CHUNK_MAX } from "../../lib/constants.js";

const sortRels = (rels: { scopeId: string; cardId: string }[]) =>
  [...rels].sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.cardId.localeCompare(b.cardId));

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "P" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "B" });
  const scopeId = await addScope({ db, name: "S" });
  const cardId = await addCard({ db, partitionId, content: "Card A" });
  return { db, namespaceId, partitionId, scopeId, cardId };
}

describe("addScopeRels", () => {
  it("does nothing for an empty list", async () => {
    const { db, scopeId } = await setup();
    await addScopeRels({ db, scopeId, cardIds: [] });
    expect(await getAllCardsByScope({ db, scopeId })).toHaveLength(0);
  });

  it("files every card into the scope in one call", async () => {
    const { db, partitionId, scopeId } = await setup();
    const cardIds = [
      await addCard({ db, partitionId, content: "one" }),
      await addCard({ db, partitionId, content: "two" }),
      await addCard({ db, partitionId, content: "three" }),
    ];
    await addScopeRels({ db, scopeId, cardIds });
    const members = await getAllCardsByScope({ db, scopeId });
    expect(members.map(({ id }) => id).sort()).toEqual([...cardIds].sort());
  });

  // Idempotent the way addScopeRel is: a card already in the scope is left as one row.
  it("ignores a card already filed into the scope", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRels({ db, scopeId, cardIds: [cardId] });
    expect(await getAllCardsByScope({ db, scopeId })).toHaveLength(1);
  });

  it("files more cards than one statement carries", async () => {
    const { db, partitionId, scopeId } = await setup();
    const cardIds: string[] = [];
    for (let index = 0; index < INSERT_CHUNK_MAX + 5; index++)
      cardIds.push(await addCard({ db, partitionId, content: `c${index}` }));
    await addScopeRels({ db, scopeId, cardIds });
    expect(await getAllCardsByScope({ db, scopeId })).toHaveLength(cardIds.length);
  });
});

describe("addScopeRel", () => {
  it("adds a card to a scope", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).toContain(cardId);
  });

  it("is idempotent — duplicate insert does not throw", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    await expect(addScopeRel({ db, scopeId, cardId })).resolves.toBeUndefined();
  });
});

describe("removeScopeRel", () => {
  it("removes the card from the scope", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    await removeScopeRel({ db, scopeId, cardId });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).not.toContain(cardId);
  });

  it("throws NotFoundError when the relationship does not exist", async () => {
    const { db, scopeId, cardId } = await setup();
    await expect(removeScopeRel({ db, scopeId, cardId })).rejects.toThrow(NotFoundError);
  });
});

describe("getAllCardsByScope", () => {
  it("returns empty array when scope has no members", async () => {
    const { db, scopeId } = await setup();
    expect(await getAllCardsByScope({ db, scopeId })).toEqual([]);
  });

  it("returns cards that are members of the scope", async () => {
    const { db, partitionId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, partitionId, content: "Card B" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: c2 });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([cardId, c2]));
    expect(cards).toHaveLength(2);
  });
});

describe("getCardsByScopeWithPartitionName", () => {
  it("returns cards with partitionName and glueId fields", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    const cards = await getCardsByScopeWithPartitionName({ db, scopeId });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(cardId);
    expect(cards[0].partitionName).toBe("B");
    expect(cards[0].glueId).toBeNull();
  });

  it("returns empty array when scope has no members", async () => {
    const { db, scopeId } = await setup();
    expect(await getCardsByScopeWithPartitionName({ db, scopeId })).toEqual([]);
  });
});

describe("addScopeMembers", () => {
  it("adds multiple cards at once", async () => {
    const { db, partitionId, namespaceId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, partitionId, content: "Card B" });
    const ok = await addScopeMembers({ db, scopeId, namespaceId, cardIds: [cardId, c2] });
    expect(ok).toEqual({ ok: true });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([cardId, c2]));
  });

  it("names the cards when a cardId does not belong to the namespace", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    await addLayer({ db, namespaceId: p1, name: "Base", isDefault: true });
    const p2 = await addNamespace({ db, name: "P2" });
    await addLayer({ db, namespaceId: p2, name: "Base", isDefault: true });
    const b1 = await addPartition({ db, namespaceId: p1, name: "B1" });
    const b2 = await addPartition({ db, namespaceId: p2, name: "B2" });
    const scopeId = await addScope({ db, name: "S" });
    const cardInP1 = await addCard({ db, partitionId: b1, content: "C1" });
    const cardInP2 = await addCard({ db, partitionId: b2, content: "C2" });
    // Trying to add a card from p2 while claiming namespace p1
    const ok = await addScopeMembers({
      db,
      scopeId,
      namespaceId: p1,
      cardIds: [cardInP1, cardInP2],
    });
    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
  });

  it("is idempotent — adding the same cards again does not duplicate them", async () => {
    const { db, namespaceId, scopeId, cardId } = await setup();
    await addScopeMembers({ db, scopeId, namespaceId, cardIds: [cardId] });
    const ok = await addScopeMembers({ db, scopeId, namespaceId, cardIds: [cardId] });
    expect(ok).toEqual({ ok: true });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards).toHaveLength(1);
  });
});

describe("scope membership refusals", () => {
  // Both of these answered a bare `false` for a missing scope and for foreign cards alike,
  // so the DELETE route told a caller its cards were foreign when the scope was what did not
  // exist. The reason is now carried out of the transaction that decided it.
  it("names the scope rather than the cards when the scope does not exist", async () => {
    const { db, namespaceId, cardId } = await setup();

    await expect(
      addScopeMembers({ db, scopeId: "no-such-scope", namespaceId, cardIds: [cardId] }),
    ).resolves.toEqual({ ok: false, reason: "foreign-scope" });
    await expect(
      removeScopeMembersFromNamespace({
        db,
        scopeId: "no-such-scope",
        namespaceId,
        cardIds: [cardId],
      }),
    ).resolves.toEqual({ ok: false, reason: "foreign-scope" });
  });
});

describe("getScopeRelsByCards", () => {
  it("returns empty array for empty cardIds", async () => {
    const { db } = await setup();
    expect(await getScopeRelsByCards({ db, cardIds: [] })).toEqual([]);
  });

  it("returns scope-rel rows for the given cards", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ scopeId, cardId });
  });
});

describe("removeScopeMembers", () => {
  it("removes all requested cards from the scope", async () => {
    const { db, partitionId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, partitionId, content: "Card B" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: c2 });

    await removeScopeMembers({ db, scopeId, cardIds: [cardId, c2] });

    expect(await getAllCardsByScope({ db, scopeId })).toEqual([]);
  });
});

describe("removeScopeMembersFromNamespace", () => {
  it("removes members when every card belongs to the namespace", async () => {
    const { db, namespaceId, partitionId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, partitionId, content: "Card B" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: c2 });

    const ok = await removeScopeMembersFromNamespace({
      db,
      scopeId,
      namespaceId,
      cardIds: [cardId, c2],
    });

    expect(ok).toEqual({ ok: true });
    expect(await getAllCardsByScope({ db, scopeId })).toEqual([]);
  });

  it("does not remove anything when a card belongs to another namespace", async () => {
    const { db, namespaceId, scopeId, cardId } = await setup();
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const otherCardId = await addCard({ db, partitionId: otherPartitionId, content: "elsewhere" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: otherCardId });

    const ok = await removeScopeMembersFromNamespace({
      db,
      scopeId,
      namespaceId,
      cardIds: [cardId, otherCardId],
    });

    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
    expect(await getScopeRelsByCards({ db, cardIds: [cardId, otherCardId] })).toHaveLength(2);
  });
});

describe("getScopeRelsByNamespace", () => {
  it("returns nothing for a namespace whose cards are in no scope", async () => {
    const { db, namespaceId } = await setup();
    expect(await getScopeRelsByNamespace({ db, namespaceId })).toEqual([]);
  });

  it("agrees with getScopeRelsByCards handed every card of the namespace", async () => {
    const { db, namespaceId, partitionId, scopeId, cardId } = await setup();
    const second = await addCard({ db, partitionId, content: "Card B" });
    const otherScopeId = await addScope({ db, name: "S2" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: second });
    await addScopeRel({ db, scopeId: otherScopeId, cardId });

    const byNamespace = await getScopeRelsByNamespace({ db, namespaceId });

    expect(byNamespace).toHaveLength(3);
    expect(sortRels(byNamespace)).toEqual(
      sortRels(await getScopeRelsByCards({ db, cardIds: [cardId, second] })),
    );
  });

  // A scope is deliberately cross-namespace, so this is the case that separates "the scopes
  // this board draws" from "every row in the table": another namespace's card filed into the
  // same scope must not arrive on this namespace's board.
  it("leaves another namespace's memberships of a shared scope out", async () => {
    const { db, namespaceId, scopeId, cardId } = await setup();
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const otherCardId = await addCard({ db, partitionId: otherPartitionId, content: "elsewhere" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: otherCardId });

    expect(await getScopeRelsByNamespace({ db, namespaceId })).toEqual([{ scopeId, cardId }]);
  });

  // `scope_rel` is the table that grows fastest, so it is the one that reaches SQLite's
  // parameter ceiling first — and reaching it stopped the board loading rather than slowing
  // it down. Selecting by namespace binds one parameter however many cards there are.
  it("reads a namespace holding more cards than one statement could name", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const layerId = (await getDefaultLayer({ db, namespaceId }))!.id;
    const cardIds = await seedCards(db, {
      partitionId,
      layerId,
      count: SQLITE_VARIABLE_MAX + 1,
      prefix: "big",
    });
    await addScopeRels({ db, scopeId, cardIds: cardIds.slice(0, 3) });

    await expect(getScopeRelsByCards({ db, cardIds }).catch(isTooManyVariables)).resolves.toBe(
      true,
    );
    await expect(getScopeRelsByNamespace({ db, namespaceId })).resolves.toHaveLength(3);
  });
});
