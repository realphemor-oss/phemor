import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SCOPE = "https://x.test/";
const PACKS = "phemor-packs";
const SHELL = "atlas-v2-shell";
const never = new Promise<never>(() => undefined);
/** A same-origin answer, the only kind the worker saves. */
const basic = (body: string) => Object.defineProperty(new Response(body), "type", { value: "basic" });

interface Opts {
  stored?: Record<string, Record<string, string>>;
  /** Simulates the slow first touch of Cache Storage on a phone with big packs: every caches.open() hangs. */
  hang?: boolean;
  online?: boolean;
  network?: (url: string) => Promise<Response>;
}

/** Loads public/sw.js with a fake worker scope. */
function boot({ stored = {}, hang = false, online = true, network = async () => basic("net") }: Opts) {
  const opened: string[] = [];
  const saved: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const caches = {
    has: async (n: string) => n in stored,
    keys: async () => Object.keys(stored),
    open: (n: string) => {
      opened.push(n);
      if (hang) return never;
      return Promise.resolve({
        match: async (u: string) => (stored[n]?.[u] !== undefined ? new Response(stored[n][u]) : undefined),
        put: async (u: string) => void saved.push(u),
        keys: async () => [],
        delete: async () => true,
      });
    },
    match: async () => {
      throw new Error("global caches.match must not be used");
    },
  };
  const self = {
    location: { origin: "https://x.test" },
    registration: { scope: SCOPE },
    navigator: { onLine: online },
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f),
    skipWaiting() {},
    clients: { claim: async () => undefined },
  };
  const ctx = { self, location: self.location, caches, fetch: (r: { url?: string } | string) => network(typeof r === "string" ? r : r.url!), URL, Response, Headers, setTimeout, clearTimeout, Promise, console };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), ctx);
  const ask = async (url: string, mode = "cors") => {
    let answer: Promise<Response> | undefined;
    listeners.fetch({
      request: { method: "GET", url, mode, headers: new Headers() },
      respondWith: (p: Promise<Response>) => (answer = p),
      waitUntil: () => undefined,
    });
    return (await answer)!.text();
  };
  return { opened, saved, ask };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("the app's own files are answered by the network even while Cache Storage is stuck", async () => {
  const w = boot({ stored: { [SHELL]: { [`${SCOPE}assets/app.js`]: "OLD" }, [PACKS]: {} }, hang: true });
  assert.equal(await w.ask(`${SCOPE}assets/app.js`), "net");
  assert.equal(await w.ask(`${SCOPE}atlas/index.json`), "net");
  assert.equal(await w.ask(SCOPE, "navigate"), "net");
});

test("without a network the saved copy is used", async () => {
  const w = boot({ stored: { [SHELL]: { [`${SCOPE}assets/app.js`]: "SAVED" } }, network: () => Promise.reject(new TypeError("offline")) });
  assert.equal(await w.ask(`${SCOPE}assets/app.js`), "SAVED");
});

test("a phone that reports being offline goes straight to the saved copy", async () => {
  let asked = 0;
  const w = boot({
    stored: { [SHELL]: { [`${SCOPE}assets/app.js`]: "SAVED" } },
    online: false,
    network: async () => (asked++, basic("net")),
  });
  assert.equal(await w.ask(`${SCOPE}assets/app.js`), "SAVED");
  assert.equal(asked, 0);
});

test("fresh answers are saved for offline use after Cache Storage is awake", async () => {
  const w = boot({ stored: { [SHELL]: {} } });
  await w.ask(`${SCOPE}assets/app.js`);
  await tick();
  assert.deepEqual(w.saved, [`${SCOPE}assets/app.js`]);
});

test("pictures and recordings are found in the word-pack cache", async () => {
  const w = boot({ stored: { [SHELL]: {}, [PACKS]: { [`${SCOPE}atlas/img/a.webp`]: "PIC", [`${SCOPE}atlas/audio/uk/a.mp3`]: "SND" } } });
  assert.equal(await w.ask(`${SCOPE}atlas/img/a.webp`), "PIC");
  assert.equal(await w.ask(`${SCOPE}atlas/audio/uk/a.mp3`), "SND");
});

test("the pack cache index is read in the background when the worker starts", async () => {
  const w = boot({ stored: { [PACKS]: {} } });
  await tick();
  assert.ok(w.opened.includes(PACKS));
});

test("a worker without packs does not create the packs cache", async () => {
  const w = boot({ stored: { [SHELL]: {} } });
  await tick();
  assert.ok(!w.opened.includes(PACKS));
});
