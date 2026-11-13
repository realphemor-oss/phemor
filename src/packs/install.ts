import type { Entry, IndexRow } from "../atlas/types";
import { decryptBytes } from "./crypto";
import { idbAll, idbDelete, idbPut } from "./idb";
import { keyForPack } from "./license";
import { allowedFile, checkManifest, PACK_CACHE, PackError, sanitizeWords, type Extras, type PackManifest } from "./spec";
import { crc32, readZipDirectory, readZipEntry, type ZipEntry } from "./zip";

/** Fired on window after a pack is installed or removed; the app reloads the word list. */
export const PACKS_CHANGED = "phemor:packs-changed";

export interface InstalledPack {
  id: string;
  manifest: PackManifest;
  installed: number;
  /** Install order; later packs override earlier ones. */
  seq: number;
  bytes: number;
  paths: string[];
  rows: IndexRow[];
  entries: Entry[];
}

export interface Progress {
  phase: "download" | "read" | "write";
  done: number;
  total: number;
}

const BASE = import.meta.env.BASE_URL;
export const urlFor = (path: string) => new URL(`${BASE}${path}`, location.origin).href;

export const supportsPacks = () => typeof caches !== "undefined" && typeof indexedDB !== "undefined" && window.isSecureContext;

export const listInstalled = async () => (await idbAll<InstalledPack>()).sort((a, b) => a.seq - b.seq);

/** Rows and entries of every installed pack, in install order. */
export async function loadExtras(topics: number, levels: number): Promise<Extras> {
  const rows: IndexRow[] = [];
  const entries: Entry[] = [];
  try {
    for (const p of await listInstalled()) {
      const clean = sanitizeWords({ rows: p.rows, entries: p.entries }, topics, levels);
      rows.push(...clean.rows);
      entries.push(...clean.entries);
    }
  } catch {
    /* a broken local database must never stop the app from starting */
  }
  return { rows, entries };
}

export async function requestPersist() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageInfo() {
  try {
    const est = (await navigator.storage?.estimate?.()) ?? {};
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  } catch {
    return { usage: 0, quota: 0, persisted: false };
  }
}

export interface InstallOptions {
  topics: number;
  levels: number;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

/** Read a pack, write its files into the cache, record its words. Safe to repeat. */
export async function installPack(blob: Blob, opts: InstallOptions): Promise<InstalledPack> {
  if (!supportsPacks()) throw new PackError("这个浏览器不支持离线单词包，请用 Safari 或 Chrome 打开。");
  const { onProgress, signal } = opts;
  const abort = () => {
    if (signal?.aborted) throw new PackError("已取消。");
  };
  onProgress?.({ phase: "read", done: 0, total: 1 });
  const dir = await readZipDirectory(blob);
  if (dir.length > 60000) throw new PackError("单词包里的文件太多。");
  const byName = new Map(dir.map((e) => [e.name, e]));
  const manifestEntry = byName.get("pack.json");
  if (!manifestEntry) throw new PackError("这不是非莫的单词包（缺少 pack.json）。");
  const text = (e: ZipEntry) => readZipEntry(blob, e).then((b) => new TextDecoder().decode(b));
  let manifest: PackManifest;
  try {
    manifest = checkManifest(JSON.parse(await text(manifestEntry)));
  } catch (e) {
    if (e instanceof PackError) throw e;
    throw new PackError("单词包的 pack.json 无法读取。");
  }

  // 加密包：先拿到激活码里的密钥，没有就在写入任何文件之前停下
  const key = manifest.crypt ? await keyForPack(manifest.id, manifest.crypt.kv, manifest.name) : null;

  let words: Extras = { rows: [], entries: [] };
  const wordsEntry = byName.get("words.json");
  if (wordsEntry) {
    try {
      const raw = await readZipEntry(blob, wordsEntry);
      const plain = key ? await decryptBytes(key, raw, manifest.id, "words.json") : raw;
      words = sanitizeWords(JSON.parse(new TextDecoder().decode(plain)), opts.topics, opts.levels);
    } catch (e) {
      if (e instanceof PackError) throw e;
      throw new PackError("单词包里的词条数据无法读取。");
    }
  }

  const files = dir.flatMap((e) => {
    if (!e.name.startsWith("files/")) return [];
    const path = e.name.slice(6);
    const type = allowedFile(path);
    return type ? [{ e, path, type }] : [];
  });
  if (!files.length && !words.rows.length) throw new PackError("这个单词包里没有可用的内容。");

  // 用第一个文件试解密：密钥不对时立刻报错，不会留下写了一半的内容
  if (key && files.length) await decryptBytes(key, await readZipEntry(blob, files[0].e), manifest.id, files[0].path);

  const cache = await caches.open(PACK_CACHE);
  const total = files.length;
  let done = 0;
  let bytes = 0;
  const paths: string[] = [];
  const queue = files.slice();
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      abort();
      const stored = await readZipEntry(blob, f.e);
      const data = key ? await decryptBytes(key, stored, manifest.id, f.path) : stored;
      await cache.put(urlFor(f.path), new Response(data, { headers: { "Content-Type": f.type, "Content-Length": String(data.length) } }));
      bytes += data.length;
      paths.push(f.path);
      onProgress?.({ phase: "write", done: ++done, total });
    }
  };
  onProgress?.({ phase: "write", done: 0, total });
  try {
    await Promise.all(Array.from({ length: 6 }, worker));
  } catch (err) {
    if (err instanceof PackError) throw err;
    throw new PackError("手机存储空间不足，或浏览器拒绝保存。请清理空间后重试。");
  }

  const old = (await listInstalled()).find((p) => p.id === manifest.id);
  const seq = old?.seq ?? Math.max(0, ...(await listInstalled()).map((p) => p.seq)) + 1;
  const record: InstalledPack = { id: manifest.id, manifest, installed: Date.now(), seq, bytes, paths, rows: words.rows, entries: words.entries };
  await idbPut(record);
  // A reinstall that no longer ships some files should not leave them behind.
  if (old) {
    const keep = new Set(paths);
    await Promise.all(old.paths.filter((p) => !keep.has(p)).map((p) => cache.delete(urlFor(p))));
  }
  void requestPersist();
  window.dispatchEvent(new Event(PACKS_CHANGED));
  return record;
}

export async function removePack(id: string) {
  const rec = (await listInstalled()).find((p) => p.id === id);
  if (!rec) return;
  const cache = await caches.open(PACK_CACHE);
  await Promise.all(rec.paths.map((p) => cache.delete(urlFor(p))));
  await idbDelete(id);
  window.dispatchEvent(new Event(PACKS_CHANGED));
}

/** Download a pack with progress; the result is a Blob the browser can keep on disk. */
export async function downloadPack(url: string, opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal } = {}): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, { signal: opts.signal, cache: "no-store" });
  } catch {
    if (opts.signal?.aborted) throw new PackError("已取消。");
    throw new PackError("下载失败：网络不通，或者这个链接不允许网页读取。");
  }
  if (!res.ok) throw new PackError(`下载失败（${res.status}），请检查链接。`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array<ArrayBuffer>);
      got += value.length;
      opts.onProgress?.({ phase: "download", done: got, total });
    }
  } catch {
    if (opts.signal?.aborted) throw new PackError("已取消。");
    throw new PackError("下载中断了，请重试。");
  }
  return new Blob(chunks);
}

/** Packs can also arrive as a catalog listing. */
export interface CatalogItem {
  id: string;
  name: string;
  version: number;
  description: string;
  kind: string;
  words: number;
  bytes: number;
  url: string;
  group: string;
  sha256?: string;
}

export async function fetchCatalog(url: string): Promise<CatalogItem[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new PackError(`目录加载失败（${res.status}）。`);
  const data = (await res.json()) as { packs?: unknown };
  const base = new URL(url, location.href);
  const out: CatalogItem[] = [];
  for (const p of Array.isArray(data.packs) ? data.packs : []) {
    if (!p || typeof p !== "object") continue;
    const q = p as Record<string, unknown>;
    if (typeof q.id !== "string" || typeof q.file !== "string" || typeof q.version !== "number") continue;
    out.push({
      id: q.id.slice(0, 48),
      name: String(q.name ?? q.id).slice(0, 60),
      version: q.version,
      description: String(q.description ?? "").slice(0, 200),
      kind: String(q.kind ?? "").slice(0, 20),
      words: Number(q.words) || 0,
      bytes: Number(q.bytes) || 0,
      group: String(q.group ?? "").slice(0, 30),
      url: new URL(q.file, base).href,
      sha256: typeof q.sha256 === "string" ? q.sha256 : undefined,
    });
  }
  return out;
}

export { crc32 };
