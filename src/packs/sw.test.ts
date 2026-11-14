import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";

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
  /** Pack files already in the database (address → content), and the "old-style packs" flag the app keeps there. */
  files?: Record<string, string>;
  legacy?: boolean;
}

/** Loads public/sw.js with a fake worker scope. */
async function seed(idb: IDBFactory, files: Record<string, string>, legacy: boolean | undefined) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open("phemor-packs", 3);
    req.onupgradeneeded = () => {
      for (const n of ["packs", "licenses", "device", "files", "meta"]) req.result.createObjectStore(n, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["files", "meta"], "readwrite");
    for (const [id, text] of Object.entries(files)) tx.objectStore("files").put({ id, type: "image/webp", data: new Blob([text]) });
    if (legacy !== undefined) tx.objectStore("meta").put({ id: "legacy", value: legacy });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function boot({ stored = {}, hang = false, online = true, network = async () => basic("net"), files = {}, legacy }: Opts) {
  const idb = new IDBFactory();
  await seed(idb, files, legacy);
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
  const ctx = { self, location: self.location, caches, indexedDB: idb, fetch: (r: { url?: string } | string) => network(typeof r === "string" ? r : r.url!), URL, Response, Headers, setTimeout, clearTimeout, Promise, console };
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
  return { opened, saved, ask, listeners };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("the app's own files are answered by the network even while Cache Storage is stuck", async () => {
  const w = await boot({ stored: { [SHELL]: { [`${SCOPE}assets/app.js`]: "OLD" }, [PACKS]: {} }, hang: true });
  assert.equal(await w.ask(`${SCOPE}assets/app.js`), "net");
  assert.equal(await w.ask(`${SCOPE}atlas/index.json`), "net");
  assert.equal(await w.ask(SCOPE, "navigate"), "net");
});

test("without a network the saved copy is used", async () => {
  const w = await boot({ stored: { [SHELL]: { [`${SCOPE}assets/app.js`]: "SAVED" } }, network: () => Promise.reject(new TypeError("offline")) });
  assert.equal(await w.ask(`${SCOPE}assets/app.js`), "SAVED");
});

test("a phone that reports being offline goes straight to the saved copy", async () => {
  let asked = 0;
  const w = await boot({
    stored: { [SHELL]: { [`${SCOPE}assets/app.js`]: "SAVED" } },
    online: false,
    network: async () => (asked++, basic("net")),
  });
  assert.equal(await w.ask(`${SCOPE}assets/app.js`), "SAVED");
  assert.equal(asked, 0);
});

test("fresh answers are saved for offline use after Cache Storage is awake", async () => {
  const w = await boot({ stored: { [SHELL]: {} } });
  await w.ask(`${SCOPE}assets/app.js`);
  await tick();
  assert.deepEqual(w.saved, [`${SCOPE}assets/app.js`]);
});

test("pictures of packs in the database are answered without touching Cache Storage", async () => {
  const w = await boot({ stored: { [SHELL]: {}, [PACKS]: {} }, hang: true, legacy: false, files: { [`${SCOPE}atlas/img/a.webp`]: "PIC" } });
  assert.equal(await w.ask(`${SCOPE}atlas/img/a.webp`), "PIC");
});

test("old-style packs are still found in the word-pack cache", async () => {
  const w = await boot({ stored: { [SHELL]: {}, [PACKS]: { [`${SCOPE}atlas/img/a.webp`]: "PIC", [`${SCOPE}atlas/audio/uk/a.mp3`]: "SND" } }, legacy: true });
  assert.equal(await w.ask(`${SCOPE}atlas/img/a.webp`), "PIC");
  assert.equal(await w.ask(`${SCOPE}atlas/audio/uk/a.mp3`), "SND");
});

test("an unknown flag is treated as old-style packs, never as none", async () => {
  const w = await boot({ stored: { [PACKS]: { [`${SCOPE}atlas/img/a.webp`]: "PIC" } } });
  assert.equal(await w.ask(`${SCOPE}atlas/img/a.webp`), "PIC");
});

test("once every pack is in the database the old pack cache is left alone", async () => {
  const w = await boot({ stored: { [SHELL]: {}, [PACKS]: { [`${SCOPE}atlas/img/a.webp`]: "OLD" } }, legacy: false, network: async () => new Response("", { status: 404 }) });
  await tick();
  w.opened.length = 0;
  await w.ask(`${SCOPE}atlas/img/a.webp`);
  assert.ok(!w.opened.includes(PACKS));
});

test("the old pack cache index is read in the background when the worker starts", async () => {
  const w = await boot({ stored: { [PACKS]: {} }, legacy: true });
  await tick(50);
  assert.ok(w.opened.includes(PACKS));
});

test("audio ranges are answered from a pack file in the database", async () => {
  const w = await boot({ stored: { [SHELL]: {} }, legacy: false, files: { [`${SCOPE}atlas/audio/uk/a.mp3`]: "0123456789" } });
  let answer: Promise<Response> | undefined;
  w.listeners.fetch({
    request: { method: "GET", url: `${SCOPE}atlas/audio/uk/a.mp3`, mode: "cors", headers: new Headers({ range: "bytes=2-4" }) },
    respondWith: (p: Promise<Response>) => (answer = p),
    waitUntil: () => undefined,
  });
  const res = await answer!;
  assert.equal(res.status, 206);
  assert.equal(await res.text(), "234");
});

test("a worker without packs does not create the packs cache", async () => {
  const w = await boot({ stored: { [SHELL]: {} }, legacy: false });
  await tick();
  assert.ok(!w.opened.includes(PACKS));
});
