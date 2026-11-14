import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

/** Loads public/sw.js with a fake worker scope and records which caches get opened. */
function boot(stored: Record<string, Record<string, string>>) {
  const opened: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const caches = {
    has: async (n: string) => n in stored,
    keys: async () => Object.keys(stored),
    open: async (n: string) => {
      opened.push(n);
      return {
        match: async (u: string) => (stored[n]?.[u] !== undefined ? new Response(stored[n][u]) : undefined),
        put: async () => undefined,
        keys: async () => [],
        delete: async () => true,
      };
    },
    match: async () => {
      throw new Error("global caches.match must not be used");
    },
  };
  const self = {
    location: { origin: "https://x.test" },
    registration: { scope: "https://x.test/" },
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f),
    skipWaiting() {},
    clients: { claim: async () => undefined },
  };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, location: self.location, caches, fetch: async () => new Response("net"), URL, Response, setTimeout, Promise, console });
  const ask = async (url: string, mode = "cors") => {
    let answer: Promise<Response> | undefined;
    listeners.fetch({
      request: { method: "GET", url, mode, headers: new Headers() },
      respondWith: (p: Promise<Response>) => (answer = p),
      waitUntil: () => undefined,
    });
    return (await answer)!.text();
  };
  return { opened, ask };
}

const PACKS = "phemor-packs";

test("scripts and the word index never wait for the word-pack cache", async () => {
  const w = boot({ "atlas-v2-shell": { "https://x.test/assets/app.js": "JS", "https://x.test/atlas/index.json": "IDX" }, [PACKS]: {} });
  await new Promise((r) => setTimeout(r, 20));
  w.opened.length = 0; // ignore the background warm-up done at start
  assert.equal(await w.ask("https://x.test/assets/app.js"), "JS");
  assert.equal(await w.ask("https://x.test/atlas/index.json"), "IDX");
  assert.ok(!w.opened.includes(PACKS), "packs cache was opened for a non-media request");
});

test("pictures and recordings are still found in the word-pack cache", async () => {
  const w = boot({ "atlas-v2-shell": {}, [PACKS]: { "https://x.test/atlas/img/a.webp": "PIC", "https://x.test/atlas/audio/uk/a.mp3": "SND" } });
  assert.equal(await w.ask("https://x.test/atlas/img/a.webp"), "PIC");
  assert.equal(await w.ask("https://x.test/atlas/audio/uk/a.mp3"), "SND");
});

test("the pack cache index is read in the background when the worker starts", async () => {
  const w = boot({ [PACKS]: {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(w.opened.includes(PACKS));
});

test("a worker without packs does not create the packs cache", async () => {
  const w = boot({ "atlas-v2-shell": {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!w.opened.includes(PACKS));
});
