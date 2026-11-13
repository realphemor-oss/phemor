/* 最小的 ZIP 写入器：只用 STORE（不压缩），固定时间戳，所以同样的输入永远得到同样的文件。
 * 和 src/packs/zip.ts 的读取器配套：不用 ZIP64，单个包必须小于 4 GB。 */
import fs from "node:fs";
import { crc32 } from "../../src/packs/zip.ts";

const DOS_TIME = 0;
const DOS_DATE = (2024 - 1980) << 9 | 1 << 5 | 1; // 2024-01-01

export interface ZipItem {
  name: string;
  data: Uint8Array;
}

export async function writeZip(path: string, items: Iterable<ZipItem> | AsyncIterable<ZipItem>) {
  const fd = fs.openSync(path, "w");
  let pos = 0;
  const write = (b: Uint8Array) => {
    let off = 0;
    while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off);
    pos += b.length;
  };
  const central: Buffer[] = [];
  try {
    for await (const it of items) {
      const name = Buffer.from(it.name, "utf8");
      const crc = crc32(it.data);
      if (it.data.length >= 0xffffffff || pos >= 0xffffffff) throw new Error("包太大（需要 ZIP64）");
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
      lh.writeUInt16LE(0, 8); // STORE
      lh.writeUInt16LE(DOS_TIME, 10);
      lh.writeUInt16LE(DOS_DATE, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(it.data.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      lh.writeUInt16LE(0, 28);
      const offset = pos;
      write(lh);
      write(name);
      write(it.data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(0, 10);
      ch.writeUInt16LE(DOS_TIME, 12);
      ch.writeUInt16LE(DOS_DATE, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(it.data.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([ch, name]));
    }
    if (central.length >= 0xffff) throw new Error("文件数太多（需要 ZIP64）");
    const cdStart = pos;
    for (const c of central) write(c);
    const cdSize = pos - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
}
