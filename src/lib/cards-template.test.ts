import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderCardsMarkdown, CARDS_TEMPLATE_FILE, type CardEntry } from "./cards-template.js";

const KOZANE_DIR = ".kozane";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "kozane-test-"));
}

const baseCard = (overrides: Partial<CardEntry> = {}): CardEntry => ({
  id: "c1",
  content: "hello",
  bundleName: "Backlog",
  glueId: null,
  posX: 0,
  posY: 0,
  ...overrides,
});

describe("renderCardsMarkdown — default template", () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders name in heading", () => {
    const out = renderCardsMarkdown({ name: "my-wc", scopeId: "s1", cards: [], projectRoot: root });
    expect(out).toContain("# my-wc");
  });

  it("renders unglued cards as list items", () => {
    const cards = [baseCard({ content: "alpha" }), baseCard({ id: "c2", content: "beta" })];
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).toContain("- alpha");
    expect(out).toContain("- beta");
  });

  it("collapses newlines to spaces for contentInline", () => {
    const cards = [baseCard({ content: "line one\nline two" })];
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).toContain("line one line two");
  });

  it("renders glued cards grouped under glues block", () => {
    const cards = [
      baseCard({ id: "c1", content: "first", glueId: "g1" }),
      baseCard({ id: "c2", content: "second", glueId: "g1" }),
      baseCard({ id: "c3", content: "solo", glueId: null }),
    ];
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).toContain("- first");
    expect(out).toContain("- second");
    expect(out).toContain("- solo");
  });

  it("omits glued cards from ungluedCards block", () => {
    const cards = [
      baseCard({ id: "c1", content: "glued", glueId: "g1" }),
      baseCard({ id: "c2", content: "free", glueId: null }),
    ];
    const template = `{{#each ungluedCards}}- {{content}}\n{{/each}}`;
    mkdirSync(join(root, KOZANE_DIR), { recursive: true });
    writeFileSync(join(root, KOZANE_DIR, CARDS_TEMPLATE_FILE), template, "utf-8");
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).not.toContain("glued");
    expect(out).toContain("- free");
  });

  it("returns empty list body when there are no cards", () => {
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards: [], projectRoot: root });
    expect(out.trim()).toBe("# wc");
  });
});

describe("renderCardsMarkdown — custom template", () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
    mkdirSync(join(root, KOZANE_DIR), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeTemplate(template: string) {
    writeFileSync(join(root, KOZANE_DIR, CARDS_TEMPLATE_FILE), template, "utf-8");
  }

  it("uses the custom template file when present", () => {
    writeTemplate("CUSTOM {{name}}");
    const out = renderCardsMarkdown({ name: "proj", scopeId: "s1", cards: [], projectRoot: root });
    expect(out).toBe("CUSTOM proj");
  });

  it("renders {{scopeId}} and {{exportedAt}} variables", () => {
    writeTemplate("scope={{scopeId}} exported={{exportedAt}}");
    const out = renderCardsMarkdown({
      name: "wc",
      scopeId: "scope-abc",
      cards: [],
      projectRoot: root,
    });
    expect(out).toContain("scope=scope-abc");
    expect(out).toMatch(/exported=\d{4}-\d{2}-\d{2}T/);
  });

  it("renders {{#each bundles}} with bundle name and cards", () => {
    writeTemplate(
      "{{#each bundles}}[{{bundleName}}:{{#each cards}}{{content}},{{/each}}]{{/each}}",
    );
    const cards = [
      baseCard({ id: "c1", content: "x", bundleName: "A" }),
      baseCard({ id: "c2", content: "y", bundleName: "B" }),
    ];
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).toContain("[A:x,]");
    expect(out).toContain("[B:y,]");
  });

  it("renders {{#each cards}} flat list with all card fields", () => {
    writeTemplate("{{#each cards}}{{id}}:{{bundleName}}:{{posX}},{{posY}}\n{{/each}}");
    const cards = [baseCard({ id: "c1", bundleName: "Todo", posX: 10, posY: 20 })];
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).toContain("c1:Todo:10,20");
  });

  it("renders contentBreak with trailing two spaces per line", () => {
    writeTemplate("{{#each cards}}{{contentBreak}}{{/each}}");
    const cards = [baseCard({ content: "a\nb" })];
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).toContain("a  \nb  ");
  });

  it("renders unknown variables as empty string", () => {
    writeTemplate("{{unknown}}");
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards: [], projectRoot: root });
    expect(out).toBe("");
  });

  it("handles nested {{#each}} blocks", () => {
    writeTemplate(
      "{{#each bundles}}{{bundleName}}:{{#each cards}}{{content}} {{/each}}\n{{/each}}",
    );
    const cards = [
      baseCard({ id: "c1", content: "p", bundleName: "X" }),
      baseCard({ id: "c2", content: "q", bundleName: "X" }),
    ];
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards, projectRoot: root });
    expect(out).toContain("X:p q ");
  });

  it("renders nothing for an empty array in #each", () => {
    writeTemplate("before{{#each bundles}}-{{/each}}after");
    const out = renderCardsMarkdown({ name: "wc", scopeId: "s1", cards: [], projectRoot: root });
    expect(out).toBe("beforeafter");
  });

  it("falls back to default template when file is absent", () => {
    const out = renderCardsMarkdown({
      name: "fallback",
      scopeId: "s1",
      cards: [],
      projectRoot: root,
    });
    expect(out).toContain("# fallback");
  });
});
