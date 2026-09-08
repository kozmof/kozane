import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { addNamespace } from "../../db/api/namespace.js";
import { resolveNamespaceId } from "./namespace-selection.js";

describe("resolveNamespaceId", () => {
  describe("with no --namespace", () => {
    it("refuses an empty workspace with the command that fixes it", async () => {
      const db = await createTestDB();
      await expect(resolveNamespaceId(db)).rejects.toThrow(/kozane namespace create/);
    });

    it("takes the sole namespace even when nothing is marked default", async () => {
      const db = await createTestDB();
      const only = await addNamespace({ db, name: "only" });
      expect(await resolveNamespaceId(db)).toBe(only);
    });

    it("takes the default namespace when there are several", async () => {
      const db = await createTestDB();
      await addNamespace({ db, name: "first" });
      const chosen = await addNamespace({ db, name: "second", isDefault: true });
      await addNamespace({ db, name: "third" });
      expect(await resolveNamespaceId(db)).toBe(chosen);
    });

    // The one case that cannot be guessed: picking arbitrarily here would file cards into
    // whichever namespace the table happened to hand over first.
    it("refuses several namespaces with no default, naming the command that sets one", async () => {
      const db = await createTestDB();
      await addNamespace({ db, name: "first" });
      await addNamespace({ db, name: "second" });
      await expect(resolveNamespaceId(db)).rejects.toThrow(/kozane namespace default/);
    });

    it("prefers the default over the sole-namespace fallback", async () => {
      const db = await createTestDB();
      const only = await addNamespace({ db, name: "only", isDefault: true });
      expect(await resolveNamespaceId(db)).toBe(only);
    });
  });

  describe("with --namespace", () => {
    it("accepts a full id", async () => {
      const db = await createTestDB();
      const namespaceId = await addNamespace({ db, name: "target" });
      await addNamespace({ db, name: "other", isDefault: true });
      expect(await resolveNamespaceId(db, namespaceId)).toBe(namespaceId);
    });

    // A short id is the last 12 characters of the compacted uuid, so an id given without
    // its dashes has to resolve to the same row the dashed form does.
    it("accepts the id with its dashes stripped", async () => {
      const db = await createTestDB();
      const namespaceId = await addNamespace({ db, name: "target" });
      expect(await resolveNamespaceId(db, namespaceId.replaceAll("-", ""))).toBe(namespaceId);
    });

    it("accepts an unambiguous short id", async () => {
      const db = await createTestDB();
      const namespaceId = await addNamespace({ db, name: "target" });
      const short = namespaceId.replaceAll("-", "").slice(-12).slice(0, 7);
      expect(await resolveNamespaceId(db, short)).toBe(namespaceId);
    });

    it("rejects an id no namespace carries", async () => {
      const db = await createTestDB();
      await addNamespace({ db, name: "target" });
      await expect(resolveNamespaceId(db, "nosuchid")).rejects.toThrow(
        "Namespace not found: nosuchid",
      );
    });

    // The default is not a fallback for a bad --namespace: a command naming a namespace that
    // is not there must fail rather than quietly write somewhere else.
    it("rejects an unknown id rather than falling back to the default", async () => {
      const db = await createTestDB();
      await addNamespace({ db, name: "fallback", isDefault: true });
      await expect(resolveNamespaceId(db, "nosuchid")).rejects.toThrow(/not found/);
    });

    it("rejects an empty workspace instead of reporting no namespaces", async () => {
      const db = await createTestDB();
      await expect(resolveNamespaceId(db, "anything")).rejects.toThrow(
        "Namespace not found: anything",
      );
    });
  });
});
