<script lang="ts">
  import { useImageResolver } from "./image-context.js";
  const resolveImageUrl = useImageResolver();
  import { imagePath } from "../images.js";
  import { parseInline } from "./inline.js";
  import { css } from "../styles/css.js";
  let { source, mode = "display", tagHref }: { source: string; mode?: "display" | "source" | "edit"; tagHref?: (tag: string) => string } = $props();
  const storedImage = $derived(imagePath(source));
  const nodes = $derived(mode !== "source" ? parseInline(source) : []);
  const labelClass = css({ borderRadius: "2px", padding: "0 4px", backgroundColor: "neutral.bg", color: "ink.tag", fontFamily: "mono", textDecoration: "none" });
</script>
{#if mode === "display" && storedImage}<img src={resolveImageUrl(storedImage)} alt="Card attachment" draggable="false" style="display: block; max-width: 100%; height: auto" />{:else if mode === "source"}{source}{:else}{#each nodes as node}{#if node.kind === "tag"}{#if tagHref && node.tag}<a href={tagHref(node.tag)} class={labelClass} onmousedown={(event) => event.stopPropagation()}>{node.source.slice(1)}</a>{:else}<span class={labelClass}>{#if mode === "edit"}<span style="font-size: 0">{node.source.slice(0, 1)}</span>{/if}{node.source.slice(1)}</span>{/if}{:else if node.kind === "link"}<a href={node.href} target="_blank" rel="noopener noreferrer" onmousedown={(event) => event.stopPropagation()} class={css({ color: "select.accent", textDecoration: "underline" })}>{node.source}</a>{:else}{node.source}{/if}{/each}{/if}
