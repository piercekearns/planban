// Reads pixels from an 8-bit RGB or RGBA PNG, so tests can check what an image actually shows.
import { inflateSync } from "node:zlib";

export function pngPixels(png: Buffer) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), depth = png[24], type = png[25];
  if (depth !== 8 || (type !== 2 && type !== 6) || png[28] !== 0) throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${png[28]}`);
  const channels = type === 6 ? 4 : 3, stride = width * channels;
  const parts: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), kind = png.toString("ascii", at + 4, at + 8);
    // Transparency declared outside the pixels would be missed, so refuse it rather than report solid colour.
    if (kind === "tRNS") throw new Error("unsupported PNG: separate transparency chunk");
    if (kind === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y * stride + x - channels]! : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      rows[y * stride + x] = (line[x]! + predictor) & 0xff;
    }
  }
  const at = (x: number, y: number) => {
    const i = y * stride + x * channels;
    return [rows[i]!, rows[i + 1]!, rows[i + 2]!, channels === 4 ? rows[i + 3]! : 255];
  };
  return { width, height, at };
}
