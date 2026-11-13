import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { crc32, readZipDirectory, readZipEntry } from "./zip.ts";

/** Build a ZIP in memory (STORE or DEFLATE) the way Python's zipfile does. */
function makeZip(files: { name: string; data: Uint8Array; deflate?: boolean }[]) {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(8, f.deflate ? 8 : 0, true);
    head.setUint32(14, crc32(f.data), true);
    head.setUint32(18, body.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(new Uint8Array(head.buffer), name, body);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, f.deflate ? 8 : 0, true);
    c.setUint32(16, crc32(f.data), true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[]);
}

const bytes = (s: string) => new TextEncoder().encode(s);

test("crc32 matches the known check value", () => {
  assert.equal(crc32(bytes("123456789")), 0xcbf43926);
});

test("reads stored and deflated entries and skips directories", async () => {
  const zip = makeZip([
    { name: "pack.json", data: bytes('{"a":1}') },
    { name: "files/atlas/img/x.webp", data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: "words.json", data: bytes("hello ".repeat(200)), deflate: true },
    { name: "files/", data: new Uint8Array() },
  ]);
  const dir = await readZipDirectory(zip);
  assert.deepEqual(
    dir.map((e) => e.name),
    ["pack.json", "files/atlas/img/x.webp", "words.json", "files/"].filter((n) => !n.endsWith("/")).concat([]),
  );
  assert.equal(new TextDecoder().decode(await readZipEntry(zip, dir[0])), '{"a":1}');
  assert.deepEqual([...(await readZipEntry(zip, dir[1]))], [1, 2, 3, 4, 5]);
  assert.equal(new TextDecoder().decode(await readZipEntry(zip, dir[2])), "hello ".repeat(200));
});

test("a flipped byte is caught by the checksum", async () => {
  const zip = makeZip([{ name: "a.bin", data: bytes("important data") }]);
  const raw = new Uint8Array(await zip.arrayBuffer());
  raw[30 + 5 + 3] ^= 0xff;
  const dir = await readZipDirectory(new Blob([raw]));
  await assert.rejects(readZipEntry(new Blob([raw]), dir[0]), /校验失败/);
});

test("truncated and non-zip files are rejected with a readable message", async () => {
  const zip = makeZip([{ name: "a.bin", data: bytes("abcdef") }]);
  const cut = zip.slice(0, zip.size - 10);
  await assert.rejects(readZipDirectory(cut), /不完整|不是单词包/);
  await assert.rejects(readZipDirectory(new Blob([bytes("hello, this is not a zip file at all")])), /不完整|不是单词包/);
  await assert.rejects(readZipDirectory(new Blob([bytes("x")])), /太小/);
});
