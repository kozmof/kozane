import type { Tx } from "../database.js";

interface ServiceFrame {
  check(): void;
  track<T>(operation: Promise<T>): Promise<T>;
}
const frames = new WeakMap<Tx, ServiceFrame>();

/** Internal bridge for opted-in execution handles. Ordinary transactions keep their existing behavior. */
export function bindActionServiceFrame(handle: Tx, frame: ServiceFrame): () => void {
  if (frames.has(handle)) throw new Error("Action service handle already bound");
  frames.set(handle, frame);
  return () => {
    frames.delete(handle);
  };
}

/** Latch validation and domain failures even if a caller catches them before any SQL runs. */
export function withActionService<T>(handle: Tx, operation: () => Promise<T>): Promise<T> {
  const frame = frames.get(handle);
  if (!frame) return operation();
  try {
    frame.check();
    return frame.track(operation());
  } catch (cause) {
    return frame.track(Promise.reject(cause));
  }
}
