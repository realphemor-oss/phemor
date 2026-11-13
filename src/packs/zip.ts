import { PackError } from "./spec";

/** Minimal ZIP reader: STORE and DEFLATE, no ZIP64, no encryption. Reads from a Blob by slices,
 * so a 150 MB pack never has to sit in memory at once. */
export interface ZipEntry {
  name: string;
  method: number;
  csize: number;
  size: number;
  crc: number;
  offset: number;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);

export async function readZipDirectory(blob: Blob): Promise<ZipEntry[]> {
  const tailSize = Math.min(blob.size, 66000);
  if (tailSize < 22) throw new PackError("文件太小，不是单词包。");
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tailSize - 22; i >= 0; i--)
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new PackError("文件不完整，或者不是单词包（可能没有传输完）。");
  const total = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new PackError("单词包太大（ZIP64），请分成多个小包。");
  if (cdOffset + cdSize > blob.size) throw new PackError("文件不完整（没有传输完）。");
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const names = new TextDecoder("utf-8");
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cd.byteLength || u32(cd, p) !== 0x02014b50) throw new PackError("单词包目录已损坏。");
    const flags = u16(cd, p + 8);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    if (flags & 1) throw new PackError("单词包被加密，无法读取。");
    const name = names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (!name.endsWith("/"))
      out.push({ name, method: u16(cd, p + 10), crc: u32(cd, p + 16), csize: u32(cd, p + 20), size: u32(cd, p + 24), offset: u32(cd, p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Bytes of one entry, checked against its CRC. */
export async function readZipEntry(blob: Blob, e: ZipEntry): Promise<Uint8Array<ArrayBuffer>> {
  const head = new DataView(await blob.slice(e.offset, e.offset + 30).arrayBuffer());
  if (head.byteLength < 30 || u32(head, 0) !== 0x04034b50) throw new PackError(`文件 ${e.name} 已损坏。`);
  const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
  if (start + e.csize > blob.size) throw new PackError("文件不完整（没有传输完）。");
  const raw = blob.slice(start, start + e.csize);
  let bytes: Uint8Array<ArrayBuffer>;
  if (e.method === 0) bytes = new Uint8Array(await raw.arrayBuffer());
  else if (e.method === 8) {
    if (typeof DecompressionStream === "undefined") throw new PackError("这个浏览器太旧，无法读取压缩的单词包。");
    const stream = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new PackError("单词包使用了不支持的压缩方式。");
  if (bytes.length !== e.size) throw new PackError(`文件 ${e.name} 大小不对，可能传输出错了。`);
  if (crc32(bytes) !== e.crc) throw new PackError(`文件 ${e.name} 校验失败，请重新下载这个单词包。`);
  return bytes;
}
