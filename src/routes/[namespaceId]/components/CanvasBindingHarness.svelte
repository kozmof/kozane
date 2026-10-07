<script lang="ts">
  import { untrack, type ComponentProps } from "svelte";
  import KozaneCanvas from "./KozaneCanvas.svelte";
  import type { CardWithGlue, ScopeArea } from "$lib/types";

  /**
   * Bind canvas state through a reactive parent so tests can observe assignments, optimistic
   * edits, and rollback rendering.
   *
   * Own the four bound values and derive visible cards from them. Accept `scopeAreas` as the
   * initial frame state.
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
   * Wrap the supplied array in a state proxy so tests can inspect gesture changes through the
   * original rows.
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
