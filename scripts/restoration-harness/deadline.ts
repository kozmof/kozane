export interface DeadlineClock {
  wait<T>(operation: Promise<T>, milliseconds: number, onTimeout: () => void): Promise<T>;
}
export function validateDeadlineDuration(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    throw new RangeError("Deadline must be a positive finite duration");
}
/** Hosts may supply a shared active clock. The default uses wall-clock time. */
export async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  onTimeout: () => void = () => {},
  clock?: DeadlineClock,
): Promise<T> {
  validateDeadlineDuration(milliseconds);
  if (clock) return clock.wait(operation, milliseconds, onTimeout);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Stage deadline exceeded"));
      onTimeout();
    }, milliseconds);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
