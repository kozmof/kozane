import { crc32, deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { validPng, validJpeg } from "./raster-validation.js";
function chunk(type: string, body: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  const content = Buffer.concat([Buffer.from(type), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(content));
  return Buffer.concat([size, content, crc]);
}
it("accepts a complete PNG and rejects forged signatures, CRC errors and missing pixels", async () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = (raw: Buffer) =>
    Buffer.concat([
      signature,
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  expect(await validPng(png(Buffer.from([0, 255, 0, 0, 255])))).toBe(true);
  expect(await validPng(Buffer.concat([signature, Buffer.alloc(16)]))).toBe(false);
  expect(await validPng(png(Buffer.alloc(0)))).toBe(false);
  const damaged = png(Buffer.from([0, 255, 0, 0, 255]));
  damaged[30] ^= 1;
  expect(await validPng(damaged)).toBe(false);
});
it("rejects JPEG marker-only files and truncated segment bodies", async () => {
  expect(validJpeg(Buffer.from([255, 216, 255, 217]))).toBe(false);
  expect(validJpeg(Buffer.from([255, 216, 255, 219, 0, 67, 0, 255, 217]))).toBe(false);
});
it("accepts interlaced PNG and rejects output beyond the decompression budget", async () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = 1;
  const png = () =>
    Buffer.concat([
      signature,
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  expect(await validPng(png())).toBe(true);
  header.writeUInt32BE(4000, 0);
  header.writeUInt32BE(4000, 4);
  header[8] = 16;
  header[12] = 0;
  expect(await validPng(png())).toBe(false);
});
function jpegFixture(progressive = false, quantization?: Buffer, huffman?: Buffer): Buffer {
  const segment = (marker: number, body: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([255, marker]), length, body]);
  };
  const counts = Buffer.from([1, ...Array(15).fill(0)]);
  const tables = Buffer.concat([
    Buffer.from([0]),
    counts,
    Buffer.from([0]),
    Buffer.from([16]),
    counts,
    Buffer.from([0]),
  ]);
  const prefix = [
    Buffer.from([255, 216]),
    segment(219, quantization ?? Buffer.from([0, ...Array(64).fill(1)])),
    segment(progressive ? 194 : 192, Buffer.from([8, 0, 1, 0, 1, 1, 1, 17, 0])),
    segment(196, huffman ?? tables),
  ];
  const scan = (start: number, end: number) =>
    Buffer.concat([segment(218, Buffer.from([1, 1, 0, start, end, 0])), Buffer.from([63])]);
  return Buffer.concat([
    ...prefix,
    ...(progressive ? [scan(0, 0), scan(1, 63)] : [scan(0, 63)]),
    Buffer.from([255, 217]),
  ]);
}
it("accepts baseline and progressive JPEG structure and rejects invalid tables", () => {
  expect(validJpeg(jpegFixture())).toBe(true);
  expect(validJpeg(jpegFixture(true))).toBe(true);
  expect(validJpeg(jpegFixture(false, Buffer.from([32, ...Array(64).fill(1)])))).toBe(false);
  expect(validJpeg(jpegFixture(false, Buffer.from([0, ...Array(63).fill(1)])))).toBe(false);
  expect(
    validJpeg(jpegFixture(false, undefined, Buffer.from([0, 2, ...Array(15).fill(0), 0]))),
  ).toBe(false);
});
