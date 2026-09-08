import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addScope,
  getScope,
  getAllScopes,
  updateScopeName,
  deleteScope,
  deleteScopeFromNamespace,
  getScopePartitionUsage,
  getScopeNamespaceUsage,
  getScopesInNamespace,
} from "./scope.js";
import { addNamespace } from "./namespace.js";
import { addPartition } from "./partition.js";
import { addCard } from "./card.js";
import { addScopeRel, getScopeRelsByCards } from "./scope-rel.js";
import { NotFoundError } from "./utils.js";
import { addLayer } from "./layer.js";
import { addTaskspace, deleteTaskspace, getTaskspace } from "./taskspace.js";

async function db() {
  return createTestDB();
}

describe("addScope", () => {
  it("returns a non-empty id", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "Release" });
    expect(id).toBeTruthy();
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

describe("deleteScopeFromNamespace", () => {
  async function setup() {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    await addLayer({ db: d, namespaceId: namespaceId, name: "Base", isDefault: true });
    const partitionId = await addPartition({ db: d, namespaceId, name: "B" });
    const scopeId = await addScope({ db: d, name: "S" });
    return { d, namespaceId, partitionId, scopeId };
  }

  it("returns false when the scope does not exist", async () => {
    const { d, namespaceId } = await setup();
    expect(await deleteScopeFromNamespace({ db: d, namespaceId, scopeId: "ghost" })).toBe(false);
  });

  it("deletes an empty scope (no members anywhere)", async () => {
    const { d, namespaceId, scopeId } = await setup();
    expect(await deleteScopeFromNamespace({ db: d, namespaceId, scopeId })).toBe(true);
    expect(await getScope({ db: d, scopeId })).toBeUndefined();
  });

  it("removes scope_rel rows for cards belonging to this namespace", async () => {
    const { d, namespaceId, partitionId, scopeId } = await setup();
    const cardId = await addCard({ db: d, partitionId, content: "hi" });
    await addScopeRel({ db: d, scopeId, cardId });

    await deleteScopeFromNamespace({ db: d, namespaceId, scopeId });

    expect(await getScopeRelsByCards({ db: d, cardIds: [cardId] })).toHaveLength(0);
  });

  it("preserves scope when another namespace's cards are still members", async () => {
    const d = await createTestDB();
    const p1 = await addNamespace({ db: d, name: "P1" });
    await addLayer({ db: d, namespaceId: p1, name: "Base", isDefault: true });
    const p2 = await addNamespace({ db: d, name: "P2" });
    await addLayer({ db: d, namespaceId: p2, name: "Base", isDefault: true });
    const b1 = await addPartition({ db: d, namespaceId: p1, name: "B1" });
    const b2 = await addPartition({ db: d, namespaceId: p2, name: "B2" });
    const scopeId = await addScope({ db: d, name: "Shared" });

    const card1 = await addCard({ db: d, partitionId: b1, content: "c1" });
    const card2 = await addCard({ db: d, partitionId: b2, content: "c2" });
    await addScopeRel({ db: d, scopeId, cardId: card1 });
    await addScopeRel({ db: d, scopeId, cardId: card2 });

    await deleteScopeFromNamespace({ db: d, namespaceId: p1, scopeId });

    // Scope still exists because p2's card remains
    expect(await getScope({ db: d, scopeId })).toBeDefined();
    // p1's card is removed; p2's card is preserved
    expect(await getScopeRelsByCards({ db: d, cardIds: [card1] })).toHaveLength(0);
    expect(await getScopeRelsByCards({ db: d, cardIds: [card2] })).toHaveLength(1);
  });

  it("preserves a card-less scope that a taskspace is still attached to", async () => {
    const { d, namespaceId, scopeId } = await setup();
    const taskspaceId = await addTaskspace({ db: d, scopeId, name: "ws" });

    expect(await deleteScopeFromNamespace({ db: d, namespaceId, scopeId })).toBe(true);

    // The scope is someone else's work in progress: attached to a taskspace, not yet
    // filed any cards into. Deleting it here would also null out that attachment.
    expect(await getScope({ db: d, scopeId })).toBeDefined();
    expect((await getTaskspace({ db: d, taskspaceId }))?.scopeId).toBe(scopeId);
  });

  it("preserves a scope whose taskspace is attached from another namespace", async () => {
    const d = await createTestDB();
    const p1 = await addNamespace({ db: d, name: "P1" });
    await addLayer({ db: d, namespaceId: p1, name: "Base", isDefault: true });
    const p2 = await addNamespace({ db: d, name: "P2" });
    await addLayer({ db: d, namespaceId: p2, name: "Base", isDefault: true });
    const b1 = await addPartition({ db: d, namespaceId: p1, name: "B1" });
    const scopeId = await addScope({ db: d, name: "Shared" });

    const card1 = await addCard({ db: d, partitionId: b1, content: "c1" });
    await addScopeRel({ db: d, scopeId, cardId: card1 });
    const taskspaceId = await addTaskspace({ db: d, namespaceId: p2, scopeId, name: "ws" });

    // p1 drops its only card, emptying the scope of cards entirely — but p2's
    // taskspace still refers to it.
    await deleteScopeFromNamespace({ db: d, namespaceId: p1, scopeId });

    expect(await getScope({ db: d, scopeId })).toBeDefined();
    expect(await getScopeRelsByCards({ db: d, cardIds: [card1] })).toHaveLength(0);
    expect((await getTaskspace({ db: d, taskspaceId }))?.scopeId).toBe(scopeId);
  });

  it("deletes a scope once its last card and last taskspace are both gone", async () => {
    const { d, namespaceId, partitionId, scopeId } = await setup();
    const cardId = await addCard({ db: d, partitionId, content: "hi" });
    await addScopeRel({ db: d, scopeId, cardId });
    const taskspaceId = await addTaskspace({ db: d, namespaceId, scopeId, name: "ws" });
    await deleteTaskspace({ db: d, taskspaceId });

    await deleteScopeFromNamespace({ db: d, namespaceId, scopeId });

    expect(await getScope({ db: d, scopeId })).toBeUndefined();
  });
});

describe("getScopesInNamespace", () => {
  async function twoNamespaces() {
    const d = await createTestDB();
    const p1 = await addNamespace({ db: d, name: "P1" });
    await addLayer({ db: d, namespaceId: p1, name: "Base", isDefault: true });
    const p2 = await addNamespace({ db: d, name: "P2" });
    await addLayer({ db: d, namespaceId: p2, name: "Base", isDefault: true });
    const b1 = await addPartition({ db: d, namespaceId: p1, name: "B1" });
    const b2 = await addPartition({ db: d, namespaceId: p2, name: "B2" });
    return { d, p1, p2, b1, b2 };
  }

  const names = (scopes: { name: string }[]) => scopes.map((s) => s.name).sort();

  it("returns an unattached scope to every namespace", async () => {
    const { d, p1, p2 } = await twoNamespaces();
    await addScope({ db: d, name: "Fresh" });

    // The sidebar creates a scope with a name and nothing else; it has to survive the
    // next poll on the board that created it.
    expect(names(await getScopesInNamespace({ db: d, namespaceId: p1 }))).toEqual(["Fresh"]);
    expect(names(await getScopesInNamespace({ db: d, namespaceId: p2 }))).toEqual(["Fresh"]);
  });

  it("returns a scope to the namespace whose cards are in it, and not to the other", async () => {
    const { d, p1, p2, b1 } = await twoNamespaces();
    const scopeId = await addScope({ db: d, name: "Mine" });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: b1, content: "c" }),
    });

    expect(names(await getScopesInNamespace({ db: d, namespaceId: p1 }))).toEqual(["Mine"]);
    expect(names(await getScopesInNamespace({ db: d, namespaceId: p2 }))).toEqual([]);
  });

  it("returns a scope to both namespaces when both have cards in it", async () => {
    const { d, p1, p2, b1, b2 } = await twoNamespaces();
    const scopeId = await addScope({ db: d, name: "Shared" });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: b1, content: "a" }),
    });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: b2, content: "b" }),
    });

    expect(names(await getScopesInNamespace({ db: d, namespaceId: p1 }))).toEqual(["Shared"]);
    expect(names(await getScopesInNamespace({ db: d, namespaceId: p2 }))).toEqual(["Shared"]);
  });

  it("returns a card-less scope to the namespace whose taskspace is attached to it", async () => {
    const { d, p1, p2 } = await twoNamespaces();
    const scopeId = await addScope({ db: d, name: "ViaTaskspace" });
    await addTaskspace({ db: d, namespaceId: p1, scopeId, name: "ws" });

    expect(names(await getScopesInNamespace({ db: d, namespaceId: p1 }))).toEqual(["ViaTaskspace"]);
    // Attached to p1, so it is no longer the unattached scope everyone could see.
    expect(names(await getScopesInNamespace({ db: d, namespaceId: p2 }))).toEqual([]);
  });

  it("returns a scope held only by an unassigned taskspace to every namespace", async () => {
    const { d, p1, p2 } = await twoNamespaces();
    const scopeId = await addScope({ db: d, name: "Unassigned" });
    await addTaskspace({ db: d, scopeId, name: "ws" });

    expect(names(await getScopesInNamespace({ db: d, namespaceId: p1 }))).toEqual(["Unassigned"]);
    expect(names(await getScopesInNamespace({ db: d, namespaceId: p2 }))).toEqual(["Unassigned"]);
  });

  it("is not confused by a null scope_id on an unrelated taskspace", async () => {
    const { d, p1 } = await twoNamespaces();
    await addScope({ db: d, name: "Fresh" });
    // A NULL in the subquery is what would make a NOT IN formulation match nothing.
    await addTaskspace({ db: d, namespaceId: p1, name: "no-scope" });

    expect(names(await getScopesInNamespace({ db: d, namespaceId: p1 }))).toEqual(["Fresh"]);
  });

  it("drops a scope from a namespace once its last card there leaves", async () => {
    const { d, p1, p2, b1, b2 } = await twoNamespaces();
    const scopeId = await addScope({ db: d, name: "Shared" });
    const c1 = await addCard({ db: d, partitionId: b1, content: "a" });
    await addScopeRel({ db: d, scopeId, cardId: c1 });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: b2, content: "b" }),
    });

    await deleteScopeFromNamespace({ db: d, namespaceId: p1, scopeId });

    expect(names(await getScopesInNamespace({ db: d, namespaceId: p1 }))).toEqual([]);
    expect(names(await getScopesInNamespace({ db: d, namespaceId: p2 }))).toEqual(["Shared"]);
  });
});

describe("getScopeNamespaceUsage", () => {
  it("reports no rows for a scope nothing refers to", async () => {
    const d = await createTestDB();
    await addScope({ db: d, name: "Fresh" });
    expect(await getScopeNamespaceUsage({ db: d })).toEqual([]);
  });

  it("reports each namespace once however many cards it has in the scope", async () => {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    await addLayer({ db: d, namespaceId, name: "Base", isDefault: true });
    const partitionId = await addPartition({ db: d, namespaceId, name: "B" });
    const scopeId = await addScope({ db: d, name: "S" });
    for (const content of ["a", "b", "c"])
      await addScopeRel({ db: d, scopeId, cardId: await addCard({ db: d, partitionId, content }) });

    expect(await getScopeNamespaceUsage({ db: d })).toEqual([{ scopeId, namespaceId }]);
  });

  it("reports a namespace reached only through a taskspace", async () => {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    const scopeId = await addScope({ db: d, name: "S" });
    await addTaskspace({ db: d, namespaceId, scopeId, name: "ws" });

    expect(await getScopeNamespaceUsage({ db: d })).toEqual([{ scopeId, namespaceId }]);
  });

  // The overlap between the two halves, which used to be collapsed in JS after running
  // them as separate queries and is now the UNION's job. A namespace that reaches one scope
  // both ways is still one row.
  it("reports a namespace reached by both a card and a taskspace once", async () => {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    await addLayer({ db: d, namespaceId, name: "Base", isDefault: true });
    const partitionId = await addPartition({ db: d, namespaceId, name: "B" });
    const scopeId = await addScope({ db: d, name: "S" });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId, content: "a" }),
    });
    await addTaskspace({ db: d, namespaceId, scopeId, name: "ws" });

    expect(await getScopeNamespaceUsage({ db: d })).toEqual([{ scopeId, namespaceId }]);
  });

  it("ignores a taskspace with no namespace and one with no scope", async () => {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    const scopeId = await addScope({ db: d, name: "S" });
    await addTaskspace({ db: d, scopeId, name: "unassigned" });
    await addTaskspace({ db: d, namespaceId, name: "unscoped" });

    expect(await getScopeNamespaceUsage({ db: d })).toEqual([]);
  });
});

describe("getScopePartitionUsage", () => {
  it("reports no rows for a scope nothing refers to", async () => {
    const d = await createTestDB();
    await addScope({ db: d, name: "Fresh" });
    expect(await getScopePartitionUsage({ db: d })).toEqual([]);
  });

  it("reports each partition once, with how many of its cards are in the scope", async () => {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    await addLayer({ db: d, namespaceId, name: "Base", isDefault: true });
    const partitionId = await addPartition({ db: d, namespaceId, name: "B" });
    const scopeId = await addScope({ db: d, name: "S" });
    const first = await addCard({ db: d, partitionId, content: "one" });
    const second = await addCard({ db: d, partitionId, content: "two" });
    await addScopeRel({ db: d, scopeId, cardId: first });
    await addScopeRel({ db: d, scopeId, cardId: second });

    expect(await getScopePartitionUsage({ db: d })).toEqual([{ scopeId, partitionId, cards: 2 }]);
  });

  /** The grain this exists for: a namespace would collapse these two into one line. */
  it("keeps two partitions of one namespace apart", async () => {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    await addLayer({ db: d, namespaceId, name: "Base", isDefault: true });
    const left = await addPartition({ db: d, namespaceId, name: "Left" });
    const right = await addPartition({ db: d, namespaceId, name: "Right" });
    const scopeId = await addScope({ db: d, name: "S" });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: left, content: "l" }),
    });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: right, content: "r" }),
    });

    expect(await getScopePartitionUsage({ db: d })).toEqual(
      expect.arrayContaining([
        { scopeId, partitionId: left, cards: 1 },
        { scopeId, partitionId: right, cards: 1 },
      ]),
    );
  });

  it("reaches across namespace lines, which is what a scope is for", async () => {
    const d = await createTestDB();
    const p1 = await addNamespace({ db: d, name: "P1" });
    const p2 = await addNamespace({ db: d, name: "P2" });
    await addLayer({ db: d, namespaceId: p1, name: "Base", isDefault: true });
    await addLayer({ db: d, namespaceId: p2, name: "Base", isDefault: true });
    const b1 = await addPartition({ db: d, namespaceId: p1, name: "One" });
    const b2 = await addPartition({ db: d, namespaceId: p2, name: "Two" });
    const scopeId = await addScope({ db: d, name: "Shared" });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: b1, content: "a" }),
    });
    await addScopeRel({
      db: d,
      scopeId,
      cardId: await addCard({ db: d, partitionId: b2, content: "b" }),
    });

    const usage = await getScopePartitionUsage({ db: d });
    expect(usage.map(({ partitionId }) => partitionId).sort()).toEqual([b1, b2].sort());
  });

  /** A taskspace places a scope on a namespace and on no partition, so it has nothing to report
   *  here — the map draws those against the namespace rectangle instead. */
  it("says nothing about a scope placed only by a taskspace", async () => {
    const d = await createTestDB();
    const namespaceId = await addNamespace({ db: d, name: "P" });
    const scopeId = await addScope({ db: d, name: "S" });
    await addTaskspace({ db: d, namespaceId, scopeId, name: "Notes", path: "notes" });

    expect(await getScopePartitionUsage({ db: d })).toEqual([]);
    expect(await getScopeNamespaceUsage({ db: d })).toEqual([{ scopeId, namespaceId }]);
  });
});
