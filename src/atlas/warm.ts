import type { Atlas } from "./types";
import { PACK_CACHE } from "../packs/spec";

/**
 * Word packs keep tens of thousands of pictures and recordings in one cache. Browsers (iOS above all)
 * read that cache's whole index the first time it is touched, which can take many seconds. Touching it
 * once, early and in the background, means the first picture or recording is no longer stuck behind it.
 * Nothing in the app waits for this.
 */
let packCacheWarm: Promise<void> | null = null;
export function warmPackCache() {
  packCacheWarm ??= (async () => {
    if (typeof caches === "undefined") return;
    if (!(await caches.has(PACK_CACHE))) return;
    const cache = await caches.open(PACK_CACHE);
    await cache.match(new URL(`${import.meta.env.BASE_URL}atlas/thumb/.warm`, location.origin).href);
  })().catch(() => undefined);
  return packCacheWarm;
}

const done = new Set<string>();

function preloadImage(src: string) {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = img.onerror = () => resolve();
    img.src = src;
  });
}

async function preloadFile(src: string) {
  try {
    await (await fetch(src)).arrayBuffer();
  } catch {
    /* offline or missing: the card falls back to what it has */
  }
}

/**
 * Warm the pictures and recordings of the words the learner will meet next (reviews due today first,
 * then the next new words, as worked out from yesterday's progress), a few at a time while the person
 * is still looking at the first screen. `ids` are in the order they will be needed.
 * `first` is how many of them are likely to open at once and get their full picture and recording too.
 */
export async function warmWords(atlas: Atlas, ids: string[], accent: "uk" | "us", first: number, cancelled: () => boolean) {
  await warmPackCache();
  const jobs: (() => Promise<void>)[] = [];
  ids.forEach((id, i) => {
    const ref = atlas.byId.get(id);
    if (!ref) return;
    const add = (key: string, src: string | null, run: (s: string) => Promise<void>) => {
      if (!src || done.has(key)) return;
      jobs.push(async () => {
        done.add(key);
        await run(src);
      });
    };
    add(`t:${id}`, atlas.img(ref, "thumb"), preloadImage);
    if (i < first) {
      add(`i:${id}`, atlas.img(ref, "full"), preloadImage);
      add(`a:${accent}:${id}`, atlas.audio(ref, accent), preloadFile);
    }
  });
  // Three at a time, never in a rush: this must not compete with what the person is doing.
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !cancelled()) {
      const job = jobs[next++];
      await job();
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
