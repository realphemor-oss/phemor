import type { Atlas, Entry, IndexRow, WordRef } from "./types";
import { MEDIA } from "./types";
import { SHELL_CACHE, type Extras } from "../packs/spec";
import { mergeWords } from "./merge";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const url = (p: string) => `${BASE}/atlas/${p}`;

interface IndexFile {
  id: string;
  name: string;
  count: number;
  examples: number;
  illustrated: number;
  chunk: number;
  topics: [string, string][];
  cefr: string[];
  words: IndexRow[];
}

let indexPromise: Promise<IndexFile> | null = null;
function fetchIndex() {
  indexPromise ??= fetch(url("index.json"))
    .then(async (res) => {
      if (!res.ok) throw new Error(`词库索引加载失败（${res.status}）`);
      return (await res.json()) as IndexFile;
    })
    .catch((e) => {
      indexPromise = null;
      throw e;
    });
  return indexPromise;
}

/** Entries fetched from the server; kept across reloads of the word list. */
const chunkCache = new Map<string, Entry>();
const chunkPending = new Map<number, Promise<void>>();
const loadChunk = (n: number) => {
  let p = chunkPending.get(n);
  if (!p) {
    p = fetch(url(`entries/${n}.json`))
      .then((r) => {
        if (!r.ok) throw new Error(`词条加载失败（${r.status}）`);
        return r.json() as Promise<Entry[]>;
      })
      .then((list) => list.forEach((e) => chunkCache.set(e.id, e)))
      .catch((e) => {
        chunkPending.delete(n);
        throw e;
      });
    chunkPending.set(n, p);
  }
  return p;
};

/**
 * Fetch every entry chunk once so the service worker keeps it; afterwards all entry text works
 * offline, even without a word pack. Nothing is parsed or kept in memory. Quiet and sequential.
 */
export async function warmEntries(signal?: { cancelled: boolean }) {
  if (typeof caches === "undefined" || !navigator.serviceWorker) return;
  if ((navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData) return;
  // On the very first visit the worker is still starting; give it a moment to take control.
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  await Promise.race([navigator.serviceWorker.ready, wait(10000)]);
  if (!navigator.serviceWorker.controller) await wait(3000);
  if (!navigator.serviceWorker.controller) return;
  const idx = await fetchIndex();
  const chunks = Math.ceil(idx.words.length / idx.chunk);
  // Look only in the app's own cache: caches.match() would also open the huge word-pack cache.
  const shell = await caches.open(SHELL_CACHE);
  for (let n = 0; n < chunks; n++) {
    if (signal?.cancelled || !navigator.onLine) return;
    const target = new URL(url(`entries/${n}.json`), location.origin).href;
    if (await shell.match(target)) continue;
    try {
      const res = await fetch(target);
      if (res.ok) await res.arrayBuffer();
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Words that installed packs add to (or correct in) the base atlas. */
export type ExtrasLoader = (topics: number, levels: number) => Promise<Extras>;

export async function loadOpenAtlas(getExtras?: ExtrasLoader): Promise<Atlas> {
  const idx = await fetchIndex();
  const extras = (await getExtras?.(idx.topics.length, idx.cefr.length).catch(() => null)) ?? { rows: [], entries: [] };
  const merged = mergeWords(idx.words, extras);
  const words: WordRef[] = merged.rows.map((r, order) => ({
    id: r[0],
    word: r[1],
    zh: r[2],
    ipa: r[3],
    cefr: r[4],
    topic: r[5],
    media: r[6],
    order,
  }));
  const byId = new Map(words.map((w) => [w.id, w]));
  const { baseIndex, overrides } = merged;
  const newExamples = extras.entries.reduce((n, e) => n + (baseIndex.has(e.id) ? 0 : e.ex.length), 0);

  return {
    id: idx.id,
    name: idx.name,
    kind: "open",
    count: words.length,
    examples: idx.examples + newExamples,
    illustrated: words.filter((w) => w.media & MEDIA.img).length,
    topics: idx.topics,
    cefr: idx.cefr,
    words,
    byId,
    peek: (id) => overrides.get(id) ?? chunkCache.get(id),
    async entry(id) {
      const hit = overrides.get(id) ?? chunkCache.get(id);
      if (hit) return hit;
      const at = baseIndex.get(id);
      if (at === undefined) throw new Error(`没有找到词条 ${id}`);
      await loadChunk(Math.floor(at / idx.chunk));
      const e = chunkCache.get(id);
      if (!e) throw new Error(`没有找到词条 ${id}`);
      return e;
    },
    img: (ref, size = "full") =>
      ("media" in ref && typeof ref.media === "number" ? ref.media : (ref as Entry).m) & MEDIA.img
        ? url(`${size === "thumb" ? "thumb" : "img"}/${ref.id}.webp`)
        : null,
    audio(ref, kind) {
      const m = "media" in ref && typeof ref.media === "number" ? ref.media : (ref as Entry).m;
      const bit = MEDIA[kind];
      return m & bit ? url(`audio/${kind}/${ref.id}.mp3`) : null;
    },
  };
}

/** Rows from the legacy private catalog served only by the local dev server. */
interface PrivateWord {
  id: string;
  seq: number;
  word: string;
  meaning: string;
  phonetic: string;
  sentence: string;
  translation: string;
  hint: string;
  image?: string | null;
  uk?: string | null;
  us?: string | null;
  sentenceAudio?: string | null;
}

export async function loadPrivateAtlas(open: Atlas | null): Promise<Atlas | null> {
  let res: Response;
  try {
    res = await fetch("/local/catalog.json", { cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return null;
  const cat = (await res.json()) as { id: string; name: string; words: PrivateWord[] };
  const entries = new Map<string, Entry>();
  const twins = new Map(open?.words.map((o) => [o.word.toLowerCase(), o]) ?? []);
  const words: WordRef[] = cat.words.map((w, order) => {
    const twin = twins.get(w.word.toLowerCase());
    const pos = (w.meaning.match(/·\s*([a-z]+\.)\s*$/) || [])[1] || "";
    const zh = w.meaning.replace(/\s*·\s*[a-z]+\.\s*$/, "");
    entries.set(w.id, {
      id: w.id,
      w: w.word,
      uk: w.phonetic,
      us: "",
      senses: [{ pos, zh, en: "" }],
      ex: w.sentence ? [{ en: w.sentence, zh: w.translation }] : [],
      col: [],
      fam: [],
      syn: [],
      ant: [],
      tip: w.hint,
      cefr: twin ? (open?.cefr[twin.cefr] ?? "B1") : "B1",
      topic: twin ? (open?.topics[twin.topic]?.[0] ?? "thinking") : "thinking",
      m: (w.image ? MEDIA.img : 0) | (w.uk ? MEDIA.uk : 0) | (w.us ? MEDIA.us : 0) | (w.sentenceAudio ? MEDIA.ex : 0),
      media: { img: w.image, uk: w.uk, us: w.us, ex: w.sentenceAudio },
    });
    return {
      id: w.id,
      word: w.word,
      zh: `${pos} ${zh}`.trim(),
      ipa: w.phonetic,
      cefr: twin?.cefr ?? 2,
      topic: twin?.topic ?? 16,
      media: entries.get(w.id)!.m,
      order,
    };
  });
  const byId = new Map(words.map((w) => [w.id, w]));
  const pick = (ref: WordRef | Entry) => entries.get(ref.id)?.media;
  return {
    id: cat.id,
    name: cat.name,
    kind: "private",
    count: words.length,
    examples: [...entries.values()].reduce((n, e) => n + e.ex.length, 0),
    illustrated: words.filter((w) => w.media & MEDIA.img).length,
    topics: open?.topics ?? [["thinking", "综合"]],
    cefr: open?.cefr ?? ["A1", "A2", "B1", "B2", "C1", "C2"],
    words,
    byId,
    peek: (id) => entries.get(id),
    entry: async (id) => {
      const e = entries.get(id);
      if (!e) throw new Error(`没有找到词条 ${id}`);
      return e;
    },
    img: (ref) => pick(ref)?.img ?? null,
    audio: (ref, kind) => pick(ref)?.[kind] ?? null,
  };
}
