/** Spike deadline. Production suspension accounting remains a separate gate requirement. */
export async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  onTimeout: () => void = () => {},
): Promise<T> {
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
