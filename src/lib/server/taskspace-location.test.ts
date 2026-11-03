import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AmbiguousNamespacePathError,
  namespaceDirName,
  namespacePathFor,
  taskspaceParentDir,
} from "./taskspace-location.js";
import { isManagedTaskspaceDirectory } from "./taskspace-directory.js";

describe("namespaceDirName", () => {
  it("keeps an ordinary name", () => {
    expect(namespaceDirName("Project", "id")).toBe("Project");
    expect(namespaceDirName("日本語", "id")).toBe("日本語");
  });

  it("turns each run of spaces into one dash", () => {
    expect(namespaceDirName("My Project", "id")).toBe("My-Project");
    expect(namespaceDirName("  a   b  ", "id")).toBe("a-b");
    expect(namespaceDirName("全角　スペース", "id")).toBe("全角-スペース");
  });

  it("replaces characters that are not allowed in folder names", () => {
    expect(namespaceDirName("a/b\\c", "id")).toBe("a-b-c");
    expect(namespaceDirName('x:y*z?"<>|', "id")).toBe("x-y-z-----");
    expect(namespaceDirName("tab\there", "id")).toBe("tab-here");
  });

  it("drops leading dots and trailing dots and spaces", () => {
    expect(namespaceDirName(".hidden", "id")).toBe("hidden");
    expect(namespaceDirName("name. . ", "id")).toBe("name");
  });

  it("falls back when nothing usable is left", () => {
    expect(namespaceDirName("..", "the-id")).toBe("the-id");
    expect(namespaceDirName("   ", "the-id")).toBe("the-id");
  });

  it("avoids names Windows reserves", () => {
    expect(namespaceDirName("CON", "id")).toBe("CON-");
    expect(namespaceDirName("lpt1", "id")).toBe("lpt1-");
  });
});

describe("namespacePathFor", () => {
  // Short IDs come from the tail, so these share a leading timestamp but not a short ID.
  const ids = [
    "019dddef-87e3-7000-ac4d-aa414b7e75d7",
    "019dddef-87e3-7000-9f10-aa41c0ffee00",
    "019dddef-87e3-7000-8b2e-5c3d9e1f2a3b",
  ];

  it("matches a full ID, with or without dashes, ignoring case", () => {
    expect(namespacePathFor({ [ids[0]]: "one" }, ids[0], ids)).toBe("one");
    expect(
      namespacePathFor({ [ids[0].replaceAll("-", "").toUpperCase()]: "one" }, ids[0], ids),
    ).toBe("one");
  });

  it("matches the short ID kozane namespace list prints", () => {
    expect(namespacePathFor({ "5c3d9e1": "three" }, ids[2], ids)).toBe("three");
    // The start of the full ID is not a short ID.
    expect(namespacePathFor({ "019dddef": "x" }, ids[2], ids)).toBeUndefined();
  });

  it("returns undefined for a namespace with no entry", () => {
    expect(namespacePathFor({ "5c3d9e1": "three" }, ids[0], ids)).toBeUndefined();
  });

  it("prefers the longest matching key", () => {
    const paths = { aa414b7: "short", [ids[0]]: "full" };
    expect(namespacePathFor(paths, ids[0], ids)).toBe("full");
  });

  it("refuses a key that matches more than one namespace", () => {
    expect(() => namespacePathFor({ aa41: "shared" }, ids[0], ids)).toThrow(
      AmbiguousNamespacePathError,
    );
  });
});

describe("taskspaceParentDir", () => {
  const namespace = { id: "ns-1", name: "Work" };
  const base = {
    defaultDir: "taskspaces",
    namespaceDirs: true,
    namespacePaths: {},
    namespace,
    allNamespaceIds: ["ns-1", "ns-2"],
  };

  it("adds the namespace folder when namespaceDirs is on", () => {
    expect(taskspaceParentDir(base)).toBe(join("taskspaces", "Work"));
  });

  it("uses defaultDir alone when namespaceDirs is off", () => {
    expect(taskspaceParentDir({ ...base, namespaceDirs: false })).toBe("taskspaces");
  });

  it("uses the namespace's own path as it is, with no namespace folder", () => {
    expect(taskspaceParentDir({ ...base, namespacePaths: { "ns-1": "work/acme" } })).toBe(
      "work/acme",
    );
    expect(taskspaceParentDir({ ...base, namespacePaths: { "ns-2": "other" } })).toBe(
      join("taskspaces", "Work"),
    );
  });
});

describe("isManagedTaskspaceDirectory", () => {
  const check = (storedPath: string) =>
    isManagedTaskspaceDirectory({
      workspaceRoot: "/work",
      storedPath,
      pathKind: "workspace_relative",
      defaultDir: "taskspaces",
      namespacePaths: ["clients/acme", "/work/abs"],
    });

  it("accepts a directory directly in defaultDir or in a namespace folder there", () => {
    expect(check(join("taskspaces", "notes"))).toBe(true);
    expect(check(join("taskspaces", "Work", "notes"))).toBe(true);
  });

  it("accepts a directory directly in a configured namespace path", () => {
    expect(check(join("clients", "acme", "notes"))).toBe(true);
    expect(check(join("abs", "notes"))).toBe(true);
  });

  it("rejects a directory elsewhere or nested deeper", () => {
    expect(check(join("src", "notes"))).toBe(false);
    expect(check(join("taskspaces", "Work", "deep", "notes"))).toBe(false);
    expect(check(join("clients", "acme", "deep", "notes"))).toBe(false);
  });
});
