import type { Entry, IndexRow } from "../atlas/types";
import { decryptBytes } from "./crypto";
import { idbAll, idbDelete, idbDeleteFiles, idbGet, idbKeys, idbPut, idbPutFiles, type StoredFile } from "./idb";
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
  /** "idb": the files live in the database (fast start-up). Missing: older install in Cache Storage. */
  store?: "idb";
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

/** Pack ids that are free and need no activation; they are read before every other pack. */
const FREE_PACK_IDS = ["list-junior"];

const idle = () =>
  new Promise<void>((resolve) =>
    typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 1000 }) : setTimeout(resolve, 60),
  );

/**
 * Start-up loader: reads the installed packs one at a time (the free pack first, then the others)
 * and reports the words gathered so far after each one. The app is already on screen by then, so
 * a phone with several large packs no longer makes you wait before anything shows.
 */
export async function loadExtrasStaged(
  topics: number,
  levels: number,
  onStage: (extras: Extras) => void | Promise<void>,
  cancelled: () => boolean = () => false,
) {
  let ids: string[] = [];
  try {
    ids = (await idbKeys()).map(String);
  } catch {
    return;
  }
  ids.sort((a, b) => Number(FREE_PACK_IDS.includes(b)) - Number(FREE_PACK_IDS.includes(a)));
  const loaded: { seq: number; rows: IndexRow[]; entries: Entry[] }[] = [];
  for (const id of ids) {
    await idle();
    if (cancelled()) return;
    try {
      const p = await idbGet<InstalledPack>(id);
      if (!p) continue;
      const clean = sanitizeWords({ rows: p.rows, entries: p.entries }, topics, levels);
      loaded.push({ seq: p.seq, rows: clean.rows, entries: clean.entries });
    } catch {
      continue; // one unreadable pack must not stop the others
    }
    loaded.sort((a, b) => a.seq - b.seq);
    if (cancelled()) return;
    await onStage({ rows: loaded.flatMap((x) => x.rows), entries: loaded.flatMap((x) => x.entries) });
  }
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

  // Files go into the database, not Cache Storage: on an iPhone the first touch of a Cache Storage holding tens of
  // thousands of files takes over ten seconds and stalls everything else that uses it.
  const total = files.length;
  let done = 0;
  let bytes = 0;
  const paths: string[] = [];
  const queue = files.slice();
  let batch: StoredFile[] = [];
  let batchBytes = 0;
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    const out = batch;
    batch = [];
    batchBytes = 0;
    writing = writing.then(() => idbPutFiles(out));
    return writing;
  };
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      abort();
      const stored = await readZipEntry(blob, f.e);
      const data = key ? await decryptBytes(key, stored, manifest.id, f.path) : stored;
      batch.push({ id: urlFor(f.path), type: f.type, data: new Blob([data], { type: f.type }) });
      batchBytes += data.length;
      bytes += data.length;
      paths.push(f.path);
      onProgress?.({ phase: "write", done: ++done, total });
      if (batch.length >= 40 || batchBytes >= 6e6) await flush(); // also keeps memory in check
    }
  };
  onProgress?.({ phase: "write", done: 0, total });
  try {
    await Promise.all(Array.from({ length: 6 }, worker));
    await flush();
  } catch (err) {
    if (err instanceof PackError) throw err;
    throw new PackError("手机存储空间不足，或浏览器拒绝保存。请清理空间后重试。");
  }

  const old = (await listInstalled()).find((p) => p.id === manifest.id);
  const seq = old?.seq ?? Math.max(0, ...(await listInstalled()).map((p) => p.seq)) + 1;
  const record: InstalledPack = { id: manifest.id, manifest, installed: Date.now(), seq, bytes, paths, rows: words.rows, entries: words.entries, store: "idb" };
  await idbPut(record);
  // A reinstall that no longer ships some files should not leave them behind.
  if (old) await dropFiles(old, old.store === "idb" ? new Set(paths) : new Set());
  void syncLegacyFlag();
  void requestPersist();
  window.dispatchEvent(new Event(PACKS_CHANGED));
  return record;
}

/** Delete a pack's files, wherever they were stored; `keep` lists paths that a newer install still ships. */
async function dropFiles(rec: InstalledPack, keep: Set<string> = new Set()) {
  const gone = rec.paths.filter((p) => !keep.has(p));
  if (rec.store === "idb") await idbDeleteFiles(gone.map(urlFor));
  else {
    const cache = await caches.open(PACK_CACHE);
    await Promise.all(gone.map((p) => cache.delete(urlFor(p))));
  }
}

export async function removePack(id: string) {
  const rec = (await listInstalled()).find((p) => p.id === id);
  if (!rec) return;
  await dropFiles(rec);
  await idbDelete(id);
  void syncLegacyFlag();
  window.dispatchEvent(new Event(PACKS_CHANGED));
}

/** True while some installed pack still keeps its files in the old Cache Storage (slow to start on iPhone). */
export const isLegacy = (p: InstalledPack) => p.store !== "idb";

/** Tell the service worker whether it still has to look in the old Cache Storage for pictures and recordings. */
export async function syncLegacyFlag() {
  try {
    const legacy = (await idbAll<InstalledPack>()).some(isLegacy);
    await idbPut({ id: "legacy", value: legacy }, "meta");
  } catch {
    /* the worker then assumes the old storage may be in use, which is always safe */
  }
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
