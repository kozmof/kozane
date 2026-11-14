import { crc32, inflate } from "node:zlib";

const PNG_OUTPUT_MAX = 64 * 1024 * 1024;

/** Validate PNG chunks and decompressed scanline layout without allocating pixels. */
export async function validPng(bytes: Uint8Array): Promise<boolean> {
  const data = Buffer.from(bytes);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8,
    width = 0,
    height = 0,
    depth = 0,
    channels = 0,
    interlace = 0;
  let header = false,
    palette = false,
    ended = false,
    sawData = false,
    dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > data.length) return false;
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, end - 4);
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return false;
    if (!header && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (header || size !== 13) return false;
      header = true;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      const color = body[9];
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
      interlace = body[12];
      if (
        !width ||
        !height ||
        width * height > 40_000_000 ||
        !depths[color]?.includes(depth) ||
        body[10] ||
        body[11] ||
        interlace > 1
      )
        return false;
      if (color === 3) palette = true;
    } else if (type === "PLTE") {
      if (sawData || !size || size % 3 || size > 768) return false;
      palette = false;
    } else if (type === "IDAT") {
      if (dataEnded || palette) return false;
      sawData = true;
      compressed.push(body);
    } else if (type === "IEND") {
      if (size || !sawData || end !== data.length) return false;
      ended = true;
      break;
    } else {
      if (sawData) dataEnded = true;
      if (!/^[a-z]/.test(type)) return false;
    }
    offset = end;
  }
  if (!ended) return false;
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => ({
    width: Math.max(0, Math.ceil((width - x) / dx)),
    height: Math.max(0, Math.ceil((height - y) / dy)),
  }));
  const expected = rows.reduce(
    (sum, row) =>
      sum + (row.width ? (1 + Math.ceil((row.width * channels * depth) / 8)) * row.height : 0),
    0,
  );
  if (expected > PNG_OUTPUT_MAX) return false;
  let raw: Buffer;
  try {
    raw = await new Promise<Buffer>((resolve, reject) =>
      inflate(Buffer.concat(compressed), { maxOutputLength: expected }, (error, output) =>
        error ? reject(error) : resolve(output),
      ),
    );
  } catch {
    return false;
  }
  if (raw.length !== expected) return false;
  let position = 0;
  for (const row of rows)
    if (row.width)
      for (let y = 0; y < row.height; y++) {
        if (raw[position] > 4) return false;
        position += 1 + Math.ceil((row.width * channels * depth) / 8);
      }
  return true;
}

/** Check JPEG segment bounds, frame dimensions, coding tables and entropy scan presence. */
export function validJpeg(bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes);
  if (data[0] !== 255 || data[1] !== 216) return false;
  let offset = 2,
    frame = false,
    quantization = false,
    coding = false,
    scan = false;
  while (offset < data.length) {
    if (data[offset++] !== 255) return false;
    while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === 217) return frame && quantization && coding && scan && offset === data.length;
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215))
      return false;
    if (offset + 2 > data.length) return false;
    const length = data.readUInt16BE(offset),
      end = offset + length;
    if (length < 2 || end > data.length) return false;
    if ([192, 193, 194].includes(marker)) {
      if (frame || length < 11) return false;
      const height = data.readUInt16BE(offset + 3),
        width = data.readUInt16BE(offset + 5),
        components = data[offset + 7];
      if (
        !height ||
        !width ||
        width * height > 40_000_000 ||
        !components ||
        length !== 8 + 3 * components
      )
        return false;
      frame = true;
    }
    if (marker === 219) {
      let cursor = offset + 2;
      if (cursor === end) return false;
      while (cursor < end) {
        const info = data[cursor++],
          precision = info >> 4,
          id = info & 15;
        if (precision > 1 || id > 3) return false;
        const size = 64 * (precision + 1);
        if (cursor + size > end) return false;
        for (let i = 0; i < 64; i++)
          if ((precision ? data.readUInt16BE(cursor + i * 2) : data[cursor + i]) === 0)
            return false;
        cursor += size;
      }
      quantization = true;
    }
    if (marker === 196) {
      let cursor = offset + 2;
      if (cursor === end) return false;
      while (cursor < end) {
        const info = data[cursor++];
        if (info >> 4 > 1 || (info & 15) > 3 || cursor + 16 > end) return false;
        let symbols = 0,
          slots = 1;
        for (let i = 0; i < 16; i++) {
          const count = data[cursor++];
          slots = slots * 2 - count;
          symbols += count;
          if (slots < 0) return false;
        }
        if (!symbols || symbols > 256 || cursor + symbols > end || slots === 0) return false;
        cursor += symbols;
      }
      coding = true;
    }
    offset = end;
    if (marker === 218) {
      if (
        !frame ||
        !quantization ||
        !coding ||
        length < 8 ||
        length !== 6 + 2 * data[end - length + 2]
      )
        return false;
      let entropy = 0;
      while (offset < data.length) {
        if (data[offset] !== 255) {
          entropy++;
          offset++;
          continue;
        }
        if (data[offset + 1] === 0 || (data[offset + 1] >= 208 && data[offset + 1] <= 215)) {
          entropy++;
          offset += 2;
          continue;
        }
        break;
      }
      if (!entropy) return false;
      scan = true;
    }
  }
  return false;
}
