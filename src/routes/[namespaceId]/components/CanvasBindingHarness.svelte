<script lang="ts">
  import { untrack, type ComponentProps } from "svelte";
  import KozaneCanvas from "./KozaneCanvas.svelte";
  import type { CardWithGlue } from "$lib/types";

  /**
   * A parent for `KozaneCanvas`, so a test can watch what it writes back.
   *
   * `cards` and `zoom` are `$bindable` on the canvas, and the paths that reassign the whole
   * array rather than writing through a row — the rollbacks, which put a card back where it
   * was when a save fails — only reach a caller through the binding. Rendering the canvas
   * directly gives it a plain object to write to, so those assignments land nowhere and the
   * one path that matters most reads as though it never ran.
   *
   * The props this does not take are the ones it owns: the two bindings, and the visible
   * list it derives from them.
   */
  type HarnessProps = Omit<
    ComponentProps<typeof KozaneCanvas>,
    "cards" | "visibleCards" | "zoom"
  > & { initialCards: CardWithGlue[] };

  let { initialCards, ...rest }: HarnessProps = $props();

  let cards = $state(untrack(() => initialCards));
  let zoom = $state(1);

  /**
   * The array the parent holds now, rather than the state itself, so a test asserts on what
   * the binding actually wrote back and not on a reference it captured before the drag.
   */
  export function read(): CardWithGlue[] {
    return cards;
  }
</script>

<KozaneCanvas bind:cards bind:zoom visibleCards={cards} {...rest} />
