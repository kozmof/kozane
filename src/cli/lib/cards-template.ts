import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KOZANE_DIR } from "./config.js";

export const CARDS_TEMPLATE_FILE = "cards.template.md";

// Variables available at the top level:
//   {{name}}          — working copy name
//   {{scopeId}}       — scope ID
//   {{exportedAt}}    — ISO timestamp
//
// {{#each bundles}}...{{/each}}
//   {{bundleName}}    — bundle name
//   {{#each cards}}...{{/each}}  (cards belonging to this bundle)
//
// {{#each glues}}...{{/each}}   (cards that belong to a glue group)
//   {{glueId}}        — glue group ID
//   {{#each cards}}...{{/each}}  (cards in this glue group)
//
// {{#each ungluedCards}}...{{/each}}  (cards not in any glue group)
//
// {{#each cards}}...{{/each}}   (flat list of all scope cards)
//   {{id}}            — card ID
//   {{content}}       — raw card content
//   {{contentInline}} — content with newlines collapsed to spaces
//   {{contentBreak}}  — content with each line suffixed with two spaces (markdown hard line break)
//   {{bundleName}}    — bundle name
//   {{glueId}}        — glue group ID, or empty string if none
//   {{posX}} {{posY}} — canvas position
const DEFAULT_TEMPLATE = `# {{name}}

{{#each glues}}---

{{#each cards}}{{contentBreak}}
{{/each}}

{{/each}}---

{{#each ungluedCards}}{{contentBreak}}
{{/each}}`;

type TemplateContext = Record<string, unknown>;

function substituteVars(text: string, ctx: TemplateContext): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = ctx[key];
    return val != null ? String(val) : "";
  });
}

function render(template: string, ctx: TemplateContext): string {
  const openTag = /\{\{#each (\w+)\}\}/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = openTag.exec(template)) !== null) {
    const blockStart = match.index;
    const key = match[1];
    const innerStart = blockStart + match[0].length;

    // Find the matching {{/each}}, tracking nesting depth
    let depth = 1;
    let pos = innerStart;
    while (pos < template.length && depth > 0) {
      if (template.startsWith("{{/each}}", pos)) {
        depth--;
        if (depth === 0) break;
        pos += 9; // "{{/each}}".length
      } else if (template.startsWith("{{#each ", pos)) {
        // skip past the full opening tag to avoid false {{/each}} matches
        const close = template.indexOf("}}", pos + 8);
        depth++;
        pos = close === -1 ? template.length : close + 2;
      } else {
        pos++;
      }
    }

    result += substituteVars(template.slice(lastIndex, blockStart), ctx);

    const inner = template.slice(innerStart, pos);
    const items = ctx[key];
    if (Array.isArray(items)) {
      result += items
        .map((item) => render(inner, { ...ctx, ...(item as TemplateContext) }))
        .join("");
    }

    const blockEnd = depth === 0 ? pos + 9 : pos;
    lastIndex = blockEnd;
    openTag.lastIndex = blockEnd;
  }

  result += substituteVars(template.slice(lastIndex), ctx);
  return result;
}

export type CardEntry = {
  id: string;
  content: string;
  bundleName: string;
  glueId: string | null;
  posX: number;
  posY: number;
};

type RenderCardsOptions = {
  name: string;
  scopeId: string;
  cards: CardEntry[];
  projectRoot: string;
};

export function renderCardsMarkdown({
  name,
  scopeId,
  cards,
  projectRoot,
}: RenderCardsOptions): string {
  const templatePath = join(projectRoot, KOZANE_DIR, CARDS_TEMPLATE_FILE);
  const template = existsSync(templatePath)
    ? readFileSync(templatePath, "utf-8")
    : DEFAULT_TEMPLATE;

  const withInline = (c: CardEntry) => ({
    ...c,
    contentInline: c.content.replaceAll("\n", " "),
    contentBreak: c.content
      .split("\n")
      .map((line) => line + "  ")
      .join("\n"),
  });

  const byBundle = Map.groupBy(cards, (c) => c.bundleName);
  const bundles = [...byBundle.entries()].map(([bundleName, bundleCards]) => ({
    bundleName,
    cards: bundleCards.map(withInline),
  }));

  const byGlue = Map.groupBy(
    cards.filter((c) => c.glueId !== null),
    (c) => c.glueId as string,
  );
  const glues = [...byGlue.entries()].map(([glueId, glueCards]) => ({
    glueId,
    cards: glueCards.map(withInline),
  }));

  const ungluedCards = cards.filter((c) => c.glueId === null).map(withInline);

  return render(template, {
    name,
    scopeId,
    exportedAt: new Date().toISOString(),
    cards: cards.map(withInline),
    bundles,
    glues,
    ungluedCards,
  });
}
