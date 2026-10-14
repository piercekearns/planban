// Compact storage for roadmaps and documents. The Revival roadmap is 948 KB
// as JSON, close to Convex's 1 MB document limit; compressed it is ~240 KB.
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function packText(text: string): ArrayBuffer {
  return toBuffer(deflateSync(strToU8(text), { level: 6 }));
}

export function unpackText(bytes: ArrayBuffer): string {
  return strFromU8(inflateSync(new Uint8Array(bytes)));
}

export function packJson(value: unknown): ArrayBuffer {
  return packText(JSON.stringify(value));
}

export function unpackJson<T>(bytes: ArrayBuffer): T {
  return JSON.parse(unpackText(bytes)) as T;
}
