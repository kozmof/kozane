import { HttpBackend, type BackendCapabilities } from "../../../client/src/index.js";
import { boardViewProps } from "./board-view-props.js";

/** Same serializable capabilities and seed on the server and hydration paths. */
export function capabilityViewProps(capabilities: BackendCapabilities, lifetimeNotice?: string) {
  const seed = boardViewProps();
  const calls: string[] = [];
  const rows = [seed.data.namespace];
  const backend = new HttpBackend({
    capabilities,
    pollingInitialDelayMs: 1000,
    fetcher: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/api/changes")) return Response.json({ token: "baseline" });
      if (String(url).endsWith("/api/snapshot")) return Response.json(seed.data);
      return Response.json([
        ...rows,
        { id: "hydrated", name: "Hydrated namespace", isDefault: false },
      ]);
    },
  });
  return {
    board: { ...seed, backend, lifetimeNotice, initialDataApplied: true },
    index: {
      backend,
      lifetimeNotice,
      initialNamespaces: rows,
      navigation: seed.navigation,
      workspaceName: "Node workspace",
      workspaceLabel: "Node workspace",
      retryIntervalMs: false as const,
    },
    calls,
  };
}
