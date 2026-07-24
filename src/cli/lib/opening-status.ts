import { activeServerProcess } from "../../lib/server/runtime-state.js";

export function openingStatus(root: string): string {
  const server = activeServerProcess(root);
  if (!server) return "stopped";
  return `running (${server.memory ? ":memory:" : "persistent"})`;
}
