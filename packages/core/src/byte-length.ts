const encoder = new TextEncoder();

/** Bytes `text` takes in UTF-8, as it is stored and sent. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}
