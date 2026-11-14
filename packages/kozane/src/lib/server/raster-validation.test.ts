import { crc32, deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { validPng, validJpeg } from './raster-validation.js';
function chunk(type: string, body: Buffer): Buffer {
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  const content = Buffer.concat([Buffer.from(type), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(content));
  return Buffer.concat([size, content, crc]);
}
it('accepts a complete PNG and rejects forged signatures, CRC errors and missing pixels', () => {
  const header = Buffer.alloc(13); header.writeUInt32BE(1,0); header.writeUInt32BE(1,4); header[8]=8; header[9]=6;
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const png = (raw: Buffer) => Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  expect(validPng(png(Buffer.from([0,255,0,0,255])))).toBe(true);
  expect(validPng(Buffer.concat([signature,Buffer.alloc(16)]))).toBe(false);
  expect(validPng(png(Buffer.alloc(0)))).toBe(false);
  const damaged=png(Buffer.from([0,255,0,0,255])); damaged[30]^=1;
  expect(validPng(damaged)).toBe(false);
});
it('rejects JPEG marker-only files and truncated segment bodies', () => {
  expect(validJpeg(Buffer.from([255,216,255,217]))).toBe(false);
  expect(validJpeg(Buffer.from([255,216,255,219,0,67,0,255,217]))).toBe(false);
});
