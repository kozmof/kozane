import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AmbiguousNamespacePathError,
  namespaceDirName,
  namespaceFolders,
  namespacePathFor,
  taskspaceParentDir,
} from "./taskspace-location.js";

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

  it("avoids reserved names that have an extension", () => {
    expect(namespaceDirName("con.txt", "id")).toBe("con-.txt");
    expect(namespaceDirName("NUL.tar.gz", "id")).toBe("NUL-.tar.gz");
    expect(namespaceDirName("console.log", "id")).toBe("console.log");
  });

  it("gives the same folder for composed and decomposed Unicode", () => {
    expect(namespaceDirName("Café", "id")).toBe(namespaceDirName("Café", "id"));
  });

  it("keeps the longest folder name with a full-ID suffix within 255 bytes", () => {
    const folders = namespaceFolders([
      { id: "019dddef-87e3-7000-8000-abcdef000001", name: "😀".repeat(100) },
      { id: "019dddef-87e3-7000-8000-abcdef000002", name: "😀".repeat(100) },
    ]);
    for (const folder of folders.values())
      expect(new TextEncoder().encode(folder).length).toBeLessThanOrEqual(255);
  });

  it("caps long names by character without splitting one", () => {
    expect(namespaceDirName("a".repeat(100), "id")).toBe("a".repeat(60));
    // 4 bytes each, so the byte cap applies first: 55 × 4 = 220 ≤ 221.
    expect([...namespaceDirName("😀".repeat(100), "id")]).toHaveLength(55);
    expect(namespaceDirName(`${"a".repeat(59)}. b`, "id")).toBe("a".repeat(59));
  });

  it("never cuts a character made of several code points", () => {
    // A family emoji is 7 code points joined by zero-width joiners: 25 bytes.
    const family = "👨‍👩‍👧‍👦";
    expect(namespaceDirName(`${"a".repeat(59)}${family}`, "id")).toBe(`${"a".repeat(59)}${family}`);
    expect(namespaceDirName(`${"a".repeat(60)}${family}`, "id")).toBe("a".repeat(60));
    // 8 families are 200 bytes; a ninth would pass the byte cap, so it is dropped whole.
    expect(namespaceDirName(family.repeat(20), "id")).toBe(family.repeat(8));
    // A `q` with a combining accent has no composed form in NFC, but stays together.
    const accented = "q́";
    expect(namespaceDirName(`${"a".repeat(59)}${accented}`, "id")).toBe(
      `${"a".repeat(59)}${accented}`,
    );
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

describe("namespaceFolders", () => {
  it("gives each namespace its cleaned name", () => {
    const folders = namespaceFolders([
      { id: "a1", name: "Work" },
      { id: "b2", name: "My notes" },
    ]);
    expect(folders).toEqual(
      new Map([
        ["a1", "Work"],
        ["b2", "My-notes"],
      ]),
    );
  });

  it("keeps the plain name for the oldest namespace and suffixes the rest", () => {
    const older = "019dddef-87e3-7000-ac4d-aa414b7e75d7";
    const newer = "019dddf0-0000-7000-8b2e-5c3d9e1f2a3b";
    // Listed newest first, to show the order comes from the IDs.
    const folders = namespaceFolders([
      { id: newer, name: "my ns" },
      { id: older, name: "My-ns" },
    ]);
    expect(folders.get(older)).toBe("My-ns");
    expect(folders.get(newer)).toBe("my-ns-5c3d9e1");
  });

  it("keeps apart names a case-insensitive disk folds together beyond lower case", () => {
    const older = "019dddef-87e3-7000-ac4d-aa414b7e75d7";
    const newer = "019dddf0-0000-7000-8b2e-5c3d9e1f2a3b";
    const folders = namespaceFolders([
      { id: older, name: "Straße" },
      { id: newer, name: "STRASSE" },
    ]);
    expect(folders.get(older)).toBe("Straße");
    expect(folders.get(newer)).toBe("STRASSE-5c3d9e1");
  });

  it("lengthens the suffix when the suffixed name is taken too", () => {
    const oldest = "019dddee-0000-7000-8000-000000000001";
    const older = "019dddef-87e3-7000-ac4d-aa414b7e75d7";
    const newer = "019dddf0-0000-7000-8b2e-5c3d9e1f2a3b";
    const folders = namespaceFolders([
      { id: oldest, name: "ns-5c3d9e1" },
      { id: older, name: "ns" },
      { id: newer, name: "ns" },
    ]);
    expect(folders.get(oldest)).toBe("ns-5c3d9e1");
    expect(folders.get(older)).toBe("ns");
    expect(folders.get(newer)).toBe("ns-5c3d9e1f");
  });
});

describe("taskspaceParentDir", () => {
  const base = {
    defaultDir: "taskspaces",
    namespaceDirs: true,
    namespacePaths: {},
    namespaceId: "ns-1",
    namespaces: [
      { id: "ns-1", name: "Work" },
      { id: "ns-2", name: "Home" },
    ],
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

  it("keeps two namespaces whose names clean to the same folder apart", () => {
    const namespaces = [
      { id: "ns-1", name: "Work" },
      { id: "ns-2", name: "work" },
    ];
    expect(taskspaceParentDir({ ...base, namespaces })).toBe(join("taskspaces", "Work"));
    expect(taskspaceParentDir({ ...base, namespaces, namespaceId: "ns-2" })).toBe(
      join("taskspaces", "work-ns2"),
    );
  });
});
