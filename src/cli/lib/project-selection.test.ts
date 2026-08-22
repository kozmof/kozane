import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { addProject } from "../../db/api/project.js";
import { resolveProjectId } from "./project-selection.js";

describe("resolveProjectId", () => {
  describe("with no --project", () => {
    it("refuses an empty workspace with the command that fixes it", async () => {
      const db = await createTestDB();
      await expect(resolveProjectId(db)).rejects.toThrow(/kozane project create/);
    });

    it("takes the sole project even when nothing is marked default", async () => {
      const db = await createTestDB();
      const only = await addProject({ db, name: "only" });
      expect(await resolveProjectId(db)).toBe(only);
    });

    it("takes the default project when there are several", async () => {
      const db = await createTestDB();
      await addProject({ db, name: "first" });
      const chosen = await addProject({ db, name: "second", isDefault: true });
      await addProject({ db, name: "third" });
      expect(await resolveProjectId(db)).toBe(chosen);
    });

    // The one case that cannot be guessed: picking arbitrarily here would file cards into
    // whichever project the table happened to hand over first.
    it("refuses several projects with no default, naming the command that sets one", async () => {
      const db = await createTestDB();
      await addProject({ db, name: "first" });
      await addProject({ db, name: "second" });
      await expect(resolveProjectId(db)).rejects.toThrow(/kozane project default/);
    });

    it("prefers the default over the sole-project fallback", async () => {
      const db = await createTestDB();
      const only = await addProject({ db, name: "only", isDefault: true });
      expect(await resolveProjectId(db)).toBe(only);
    });
  });

  describe("with --project", () => {
    it("accepts a full id", async () => {
      const db = await createTestDB();
      const projectId = await addProject({ db, name: "target" });
      await addProject({ db, name: "other", isDefault: true });
      expect(await resolveProjectId(db, projectId)).toBe(projectId);
    });

    // A short id is the last 12 characters of the compacted uuid, so an id given without
    // its dashes has to resolve to the same row the dashed form does.
    it("accepts the id with its dashes stripped", async () => {
      const db = await createTestDB();
      const projectId = await addProject({ db, name: "target" });
      expect(await resolveProjectId(db, projectId.replaceAll("-", ""))).toBe(projectId);
    });

    it("accepts an unambiguous short id", async () => {
      const db = await createTestDB();
      const projectId = await addProject({ db, name: "target" });
      const short = projectId.replaceAll("-", "").slice(-12).slice(0, 7);
      expect(await resolveProjectId(db, short)).toBe(projectId);
    });

    it("rejects an id no project carries", async () => {
      const db = await createTestDB();
      await addProject({ db, name: "target" });
      await expect(resolveProjectId(db, "nosuchid")).rejects.toThrow("Project not found: nosuchid");
    });

    // The default is not a fallback for a bad --project: a command naming a project that
    // is not there must fail rather than quietly write somewhere else.
    it("rejects an unknown id rather than falling back to the default", async () => {
      const db = await createTestDB();
      await addProject({ db, name: "fallback", isDefault: true });
      await expect(resolveProjectId(db, "nosuchid")).rejects.toThrow(/not found/);
    });

    it("rejects an empty workspace instead of reporting no projects", async () => {
      const db = await createTestDB();
      await expect(resolveProjectId(db, "anything")).rejects.toThrow("Project not found: anything");
    });
  });
});
