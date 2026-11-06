import type { ActiveClock } from "./active-clock";
/** Visibility alone never pauses deadlines. Lifecycle reasons may overlap. */
export function trackSuspension(
  clock: ActiveClock,
  target: Window = window,
  documentTarget: Document = document,
): () => void {
  const hide = (event: PageTransitionEvent) => {
    if (event.persisted) clock.suspend("bfcache");
  };
  const show = () => clock.resume("bfcache");
  const freeze = () => clock.suspend("freeze");
  const resume = () => clock.resume("freeze");
  target.addEventListener("pagehide", hide);
  target.addEventListener("pageshow", show);
  const lifecycle = "onfreeze" in documentTarget || "onresume" in documentTarget;
  if (lifecycle) {
    documentTarget.addEventListener("freeze", freeze);
    documentTarget.addEventListener("resume", resume);
  }
  return () => {
    target.removeEventListener("pagehide", hide);
    target.removeEventListener("pageshow", show);
    if (lifecycle) {
      documentTarget.removeEventListener("freeze", freeze);
      documentTarget.removeEventListener("resume", resume);
    }
  };
}
