import type { BackendCapabilities } from "../../../client/src/index.js";
import { hydrate, tick, unmount } from "svelte";
import { BoardView, NamespacesView } from "../../../client/src/ui.js";
import { capabilityViewProps } from "./capability-view-props.js";

export async function hydrateCapabilityViews(
  capabilities: BackendCapabilities,
  lifetimeNotice?: string,
) {
  const props = capabilityViewProps(capabilities, lifetimeNotice);
  const indexTarget = document.querySelector<HTMLElement>("#index")!;
  const boardTarget = document.querySelector<HTMLElement>("#board")!;
  const dispose: (() => Promise<void>)[] = [];
  try {
    const index = hydrate(NamespacesView, { target: indexTarget, props: props.index });
    dispose.push(() => unmount(index));
    const board = hydrate(BoardView, { target: boardTarget, props: props.board });
    dispose.push(() => unmount(board));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = {
      kind: props.board.backend.kind,
      capabilities: props.board.backend.capabilities,
      namespaceCreate: !!indexTarget.querySelector('[aria-label="Create namespace"]'),
      cardCreate: !!boardTarget.querySelector('[aria-label="Create card"]'),
      modeText: [...document.querySelectorAll('aside[aria-label="Workspace mode"]')].map(
        (node) => node.textContent,
      ),
      refreshed: indexTarget.textContent?.includes("Hydrated namespace") === true,
      calls: [...props.calls],
    };
    return result;
  } finally {
    for (const release of dispose.reverse()) await release();
  }
}
