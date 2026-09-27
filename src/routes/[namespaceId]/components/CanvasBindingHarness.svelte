<script lang="ts">
  import { untrack, type ComponentProps } from "svelte";
  import KozaneCanvas from "./KozaneCanvas.svelte";
  import type { CardWithGlue } from "$lib/types";

  /**
   * A parent for `KozaneCanvas`, so a test can watch what it writes back.
   *
   * `cards`, `zoom` and `pendingScopeAreaRect` are `$bindable` on the canvas, and what it
   * writes to them only reaches a caller through the binding: the rollbacks that put a card
   * back when a save fails reassign the whole array, and a drawn scope-area rectangle is
   * written to the prop outright. Rendering the canvas directly gives it a plain object to
   * write to, so those assignments land nowhere and the paths that matter most read as
   * though they never ran.
   *
   * The props this does not take are the ones it owns: the three bindings, and the visible
   * list it derives from them.
   */
  type HarnessProps = Omit<
    ComponentProps<typeof KozaneCanvas>,
    "cards" | "visibleCards" | "zoom" | "pendingScopeAreaRect"
  > & { initialCards: CardWithGlue[] };

  let { initialCards, ...rest }: HarnessProps = $props();

  let cards = $state(untrack(() => initialCards));
  let zoom = $state(1);
  let pendingScopeAreaRect = $state<{ x: number; y: number; w: number; h: number } | null>(null);

  /**
   * The array the parent holds now, rather than the state itself, so a test asserts on what
   * the binding actually wrote back and not on a reference it captured before the drag.
   */
  export function read(): CardWithGlue[] {
    return cards;
  }

  /** The rectangle the canvas last drew and handed over, or null. */
  export function readPendingRect(): { x: number; y: number; w: number; h: number } | null {
    return pendingScopeAreaRect;
  }
</script>

<KozaneCanvas bind:cards bind:zoom bind:pendingScopeAreaRect visibleCards={cards} {...rest} />
