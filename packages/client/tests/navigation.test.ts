import { expect, it } from "vitest";
import { createDemoNavigation, createNodeNavigation } from "../src/navigation.js";
it("preserves Node routes, filter order, file escaping, and export warp slashes", () => {
  const navigation = createNodeNavigation({ base: "/base" });
  expect(navigation.namespaces()).toBe("/base/");
  expect(navigation.board("ns /x", { taskspace: "t1", path: "notes/my file.md" })).toBe(
    "/base/ns%20%2Fx?taskspace=t1&path=notes%2Fmy%20file.md",
  );
  expect(navigation.tags({ namespaceId: "ns", tag: "perf:cache" })).toBe(
    "/base/tags?namespaceId=ns&tag=perf%3Acache",
  );
  expect(navigation.map({ namespaceId: "ns", tag: "a b", day: "2026-10-01" })).toBe(
    "/base/map?namespaceId=ns&tag=a+b&day=2026-10-01",
  );
  const exported = createNodeNavigation({ boardTrailingSlash: () => true });
  expect(exported.board("ns", { warp: "w /x" })).toBe("/ns/?warp=w%20%2Fx");
  expect(Object.isFrozen(navigation)).toBe(true);
});
it("keeps demo content in fragments on fixed directory routes", () => {
  const navigation = createDemoNavigation({ base: "/demo/" });
  const tag = "private &?/日本語#";
  const path = "private notes/a b.md";
  const map = new URL(
    navigation.map({ namespaceId: "ns", tag, day: "2026-10-01" }),
    "https://example.test",
  );
  expect(map.pathname).toBe("/demo/map/");
  expect(map.search).toBe("?namespaceId=ns");
  expect(new URLSearchParams(map.hash.slice(1)).get("tag")).toBe(tag);
  expect(navigation.readFilters(map)).toEqual({ namespaceId: "ns", tag, day: "2026-10-01" });
  const file = new URL(
    navigation.board("ns", { card: "c1", taskspace: "t1", path }),
    "https://example.test",
  );
  expect(file.pathname).toBe("/demo/board/");
  expect(file.search).toBe("?namespaceId=ns&card=c1&taskspace=t1");
  expect(new URLSearchParams(file.hash.slice(1)).get("path")).toBe(path);
  const tags = new URL(navigation.tags({ tag }), "https://example.test");
  expect(tags.pathname).toBe("/demo/tags/");
  expect(tags.search).toBe("");
  expect(new URLSearchParams(tags.hash.slice(1)).get("tag")).toBe(tag);
  expect(navigation.namespaces()).toBe("/demo/namespaces/");
  expect(navigation.map()).toBe("/demo/map/");
  expect(navigation.board("ns")).toBe("/demo/board/?namespaceId=ns");
});
it("reads Node filters from queries and demo filters only from fragments", () => {
  const url = new URL(
    "https://example.test/map/?namespaceId=ns&tag=server&day=2026-01-01#tag=local&day=2026-02-02",
  );
  expect(createNodeNavigation().readFilters(url)).toEqual({
    namespaceId: "ns",
    tag: "server",
    day: "2026-01-01",
  });
  expect(createDemoNavigation().readFilters(url)).toEqual({
    namespaceId: "ns",
    tag: "local",
    day: "2026-02-02",
  });
  expect(
    createDemoNavigation().readFilters(new URL("https://example.test/map/?tag=ignored")),
  ).toEqual({ namespaceId: null, tag: null, day: null });
});

it("reads and clears Node arrival parameters while retaining unrelated queries and fragments", () => {
  const navigation = createNodeNavigation();
  const url = new URL(
    "https://example.test/ns/?card=c1&warp=w1&taskspace=t1&path=notes%2Fmy%20file.md&scope=reading#heading",
  );
  expect(navigation.readBoard(url)).toEqual({
    card: "c1",
    warp: "w1",
    taskspace: "t1",
    path: "notes/my file.md",
  });
  expect(navigation.clearBoard(url, ["card", "warp", "taskspace", "path"])).toBe(
    "/ns/?scope=reading#heading",
  );
  expect(url.searchParams.get("card")).toBe("c1");
});
it("reads demo file paths only from fragments and clears only handled selectors", () => {
  const navigation = createDemoNavigation();
  const url = new URL(
    "https://example.test/board/?namespaceId=ns&card=c1&taskspace=t1#path=notes%2Fmy+file.md&tag=private%3Atag",
  );
  expect(navigation.readBoard(url)).toMatchObject({
    card: "c1",
    taskspace: "t1",
    path: "notes/my file.md",
  });
  expect(navigation.clearBoard(url, ["card"])).toBe(
    "/board/?namespaceId=ns&taskspace=t1#path=notes%2Fmy+file.md&tag=private%3Atag",
  );
  expect(navigation.clearBoard(url, ["card", "taskspace", "path"])).toBe(
    "/board/?namespaceId=ns#tag=private%3Atag",
  );
  expect(
    navigation.clearBoard(
      new URL("https://example.test/board/?namespaceId=ns&taskspace=t1#path=notes"),
      ["taskspace", "path"],
    ),
  ).toBe("/board/?namespaceId=ns");
  expect(
    navigation.readBoard(new URL("https://example.test/board/?namespaceId=ns&path=ignored")).path,
  ).toBeUndefined();
});
