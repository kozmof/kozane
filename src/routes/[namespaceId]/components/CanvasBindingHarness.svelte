<script lang="ts">
  import { untrack, type ComponentProps } from "svelte";
  import KozaneCanvas from "./KozaneCanvas.svelte";
  import type { CardWithGlue, ScopeArea } from "$lib/types";

  /**
   * A parent for `KozaneCanvas`, so a test can watch what it writes back.
   *
   * `cards`, `zoom`, `pendingScopeAreaRect` and `scopeAreas` are `$bindable` on the canvas,
   * and what it writes to them only reaches a caller through the binding: the rollbacks that
   * put a card back when a save fails reassign the whole array, and a drawn scope-area
   * rectangle is written to the prop outright. Rendering the canvas directly gives it a plain
   * object to write to, so those assignments land nowhere and the paths that matter most read
   * as though they never ran.
   *
   * It is also the only way a *drag* is observable in the drawn output rather than only in
   * the row it mutated. The gestures write positions through the rows — a frame's `posX`, a
   * card's `posY` — and a plain prop object is not state, so nothing re-renders: the frame,
   * its cards, and the icon strip under it all stay where they were drawn. A parent that owns
   * the arrays as state is what turns those writes into styles a test can read off the box.
   *
   * The props this does not take are the ones it owns: the four bindings, and the visible
   * list it derives from them. `scopeAreas` is taken as its initial value, under its own
   * name, so a test still passes the frames the same way it passes them to the canvas.
   */
  type HarnessProps = Omit<
    ComponentProps<typeof KozaneCanvas>,
    "cards" | "visibleCards" | "zoom" | "pendingScopeAreaRect" | "scopeAreas"
  > & { initialCards: CardWithGlue[]; scopeAreas?: ScopeArea[] };

  let { initialCards, scopeAreas: initialScopeAreas = [], ...rest }: HarnessProps = $props();

  let cards = $state(untrack(() => initialCards));
  let zoom = $state(1);
  let pendingScopeAreaRect = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  /**
   * A proxy over the array the test handed in, not a copy of it: `$state` wraps that same
   * array and its rows, so a caller still reads what a gesture wrote by looking at the rows
   * it passed.
   */
  let scopeAreas = $state(untrack(() => initialScopeAreas));

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

  /** The frames the parent holds now, for the same reason {@link read} exists. */
  export function readScopeAreas(): ScopeArea[] {
    return scopeAreas;
  }
</script>

<KozaneCanvas
  bind:cards
  bind:zoom
  bind:pendingScopeAreaRect
  bind:scopeAreas
  visibleCards={cards}
  {...rest}
/>
