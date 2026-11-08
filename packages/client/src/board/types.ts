import type { NamespaceGetResult, SnapshotData } from "../client/contract.js";
import type { BoardViewClient } from "../client/view-clients.js";
import type { PollLifecycle } from "../client/workspace-poller.js";
import type { NavigationAdapter, NavigationDriver } from "../navigation.js";
import type { PreferenceStorage } from "../preferences.js";
import type { UiConfig } from "../ui-config.js";
import type { WarpListEntry } from "../warp-list.js";
export type BoardPageData = SnapshotData & {
  namespace: NamespaceGetResult;
  otherNamespaces: NamespaceGetResult[];
  uiConfig: UiConfig;
  warpDirectory?: WarpListEntry[];
};
export interface BoardViewProps {
  data: BoardPageData;
  backend: BoardViewClient;
  navigation: NavigationAdapter;
  routing: NavigationDriver;
  preferences: PreferenceStorage;
  /** Host-supplied lifetime wording. Does not imply recovery storage support. */
  lifetimeNotice?: string;
  /** Read the current route reactively and during cleanup, or return null without a route. */
  readRouteUrl?: () => URL | null;
  /** Trust the seed only when it was validated for the current backend generation. */
  initialDataApplied?: boolean;
  retryIntervalMs?: number | false;
  lifecycle?: Pick<PollLifecycle, "listen">;
  isHidden?: () => boolean;
}
