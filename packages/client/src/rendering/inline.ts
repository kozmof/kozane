import { segmentText } from "../text-segments.js";
export type InlineNode = {
  kind: "text" | "tag" | "link";
  source: string;
  start: number;
  end: number;
  tag?: string;
  href?: string;
};
export function parseInline(source: string): InlineNode[] {
  let offset = 0;
  return segmentText(source).map((part) => {
    const start = offset;
    offset += part.text.length;
    return {
      kind: part.href ? "link" : part.tag ? "tag" : "text",
      source: part.text,
      start,
      end: offset,
      tag: part.tag,
      href: part.href,
    };
  });
}

/** Editing projection preserves every character and direct text-node geometry. */
export function renderSource(source: string): string { return source; }
