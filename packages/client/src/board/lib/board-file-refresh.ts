import { startDatasetView } from "../../client/dataset-view.js";
import { ClientError } from "../../client/contract.js";
import type { EditorSessionContext } from "../../editor/index.js";
import type { NamespaceState } from "../namespace-state.svelte.js";
type DatasetOptions = Parameters<typeof startDatasetView>[0];
/** Own cancellation and discard results from obsolete generations. */
export function startBoardFileRefresh(options: {
  context: EditorSessionContext;
  client: DatasetOptions["backend"];
  tree: NamespaceState["taskspaceTree"];
  retryIntervalMs: DatasetOptions["retryIntervalMs"];
  lifecycle: DatasetOptions["lifecycle"];
  isHidden: DatasetOptions["isHidden"];
  refreshed: () => void;
  error: () => void;
}) {
  const client = options.client;
  let active = true;
  const generation = client.version.generation;
  const stop = startDatasetView({
    backend: client,
    dataset: "snapshot",
    retryIntervalMs: options.retryIntervalMs,
    lifecycle: options.lifecycle,
    isHidden: options.isHidden,
    read: async (isCurrent, readOptions) => {
      const ok = await options.tree.refreshWatched(
        { ...options.context, readOptions },
        () => active && client.version.generation === generation && isCurrent(),
      );
      if (!ok) throw new ClientError("unavailable", "Could not refresh files");
    },
    apply: options.refreshed,
    error: options.error,
  });
  return () => {
    active = false;
    stop();
  };
}
