import { getContext, setContext, onDestroy, untrack } from "svelte";
import { browser } from "$app/environment";
import { base } from "$app/paths";
import type { ManagedClient, StaticClientData } from "@kozane/client";
import type { PageClientSelection } from "$lib/client-session.js";
import { WorkspaceClientSession } from "$lib/client-session.js";

const sessionKey = Symbol("workspace-client-session");
function createOwnedSession(): WorkspaceClientSession {
  const session = new WorkspaceClientSession({ base, observeChanges: browser });
  const pagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) session.dispose();
  };
  if (browser) window.addEventListener("pagehide", pagehide);
  onDestroy(() => {
    if (browser) window.removeEventListener("pagehide", pagehide);
    session.dispose();
  });
  return session;
}
export function provideWorkspaceClientSession(): WorkspaceClientSession {
  return setContext(sessionKey, createOwnedSession());
}
/** Standalone route rendering owns a private session when no root layout is present. */
export function useWorkspaceClientSession(): WorkspaceClientSession {
  return getContext<WorkspaceClientSession | undefined>(sessionKey) ?? createOwnedSession();
}

export function selectWorkspaceClient(
  session: WorkspaceClientSession,
  data: PageClientSelection,
  fallback: () => StaticClientData,
): ManagedClient;
export function selectWorkspaceClient(
  session: WorkspaceClientSession,
  data: PageClientSelection,
): ManagedClient | undefined;
/** The data argument remains reactive; resource notifications run outside derived evaluation. */
export function selectWorkspaceClient(
  session: WorkspaceClientSession,
  data: PageClientSelection,
  fallback?: () => StaticClientData,
): ManagedClient | undefined {
  return untrack(() => (fallback ? session.select(data, fallback) : session.select(data)));
}
