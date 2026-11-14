/* 非莫离线服务。
 * - 页面、脚本、样式、词库目录、词条文字：优先联网（浏览器自己的 HTTP 缓存几毫秒就能答），
 *   联网不通或太慢才用本机缓存，所以信号差、离线也能打开。
 * - 插画和发音：本机有就直接用（先 App 自己的缓存，再 phemor-packs 单词包缓存），没有再联网并记住。
 * - 单词包写入的 phemor-packs 缓存永远不会被这里清理，只能在 App 里移除。
 * - 重要：苹果系统第一次用 Cache Storage 时，要把里面几万条单词包记录整体读一遍，实测要 17 秒以上，
 *   这段时间里所有 caches 调用都排队。所以联网能答的请求绝不先碰 caches，保存离线副本也要等它醒来之后。
 * - 支持 Range 请求：iPhone 播放音频必须靠它，否则离线时发音会失效。 */
const VERSION = "atlas-v2";
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;
const PACKS = "phemor-packs";
const NETWORK_WAIT = 1500;
const ASSET_WAIT = 4000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Only our own versioned runtime caches are swept; the packs cache is the user's data.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("atlas-") && !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** The page sends the list of files it loaded, so the first visit is already enough for offline use. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "precache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      Promise.all(
        data.urls
          .filter((u) => typeof u === "string" && u.startsWith(self.registration.scope))
          .slice(0, 200)
          .map((u) =>
            cache
              .match(u)
              .then((hit) => hit || fetch(u).then((res) => (res.ok && res.type === "basic" ? cache.put(u, res) : null)))
              .catch(() => null),
          ),
      ),
    ),
  );
});

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** Answer a Range request from a full cached response (what <audio> on iOS always sends). */
async function sliceResponse(hit, rangeHeader) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!m || (m[1] === "" && m[2] === "")) return hit;
  const blob = await hit.blob();
  const size = blob.size;
  let start;
  let end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": hit.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

const isMediaUrl = (url) => /\/atlas\/(img|thumb|audio)\//.test(url);

async function fromCache(name, url) {
  try {
    return await (await caches.open(name)).match(url);
  } catch {
    return undefined;
  }
}

/** Never uses the global caches.match(): that would open the (huge) packs cache for every request. */
async function lookup(req) {
  const url = req.url;
  if (!isMediaUrl(url)) return (await fromCache(SHELL, url)) || (await fromCache(MEDIA, url));
  // Pictures and recordings: the small caches first, then the word packs.
  return (await fromCache(MEDIA, url)) || (await fromCache(PACKS, url)) || (await fromCache(SHELL, url));
}

// Start reading the packs cache index in the background as soon as the worker wakes up,
// so by the time the first picture is wanted it is usually ready. Nothing waits for this
// except the pictures and recordings themselves, and the saving of fresh copies below.
const cacheReady = caches
  .has(PACKS)
  .then((has) => (has ? caches.open(PACKS).then((c) => c.match(new URL("./atlas/thumb/.warm", self.registration.scope).href)) : null))
  .then(() => undefined, () => undefined);

/**
 * Keep a copy of a fresh answer for offline use. It waits until the cache storage has finished waking up
 * (so it does not slow that down) and no reply ever waits for it. On an iPhone with big word packs the first
 * touch of Cache Storage can take well over ten seconds; every request that needs it stalls until it is done.
 */
function saveLater(event, url, res) {
  if (!res.ok || res.type !== "basic") return;
  const copy = res.clone();
  let release = () => undefined;
  try {
    event.waitUntil(new Promise((r) => (release = r)));
  } catch {
    /* the worker may be stopped before the copy is saved; the next visit saves it again */
  }
  const timer = setTimeout(() => release(), 60000);
  cacheReady
    .then(() => caches.open(SHELL))
    .then((c) => c.put(url, copy))
    .catch(() => null)
    .then(() => {
      clearTimeout(timer);
      release();
    });
}

async function networkFirst(event, req) {
  const cached = () => lookup(req).then((hit) => hit || fromCache(SHELL, new URL("./", self.registration.scope).href));
  const net = fetch(req).then((res) => {
    saveLater(event, req.url, res);
    return res;
  });
  const wait = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT, null));
  try {
    const first = await Promise.race([net.catch(() => null), wait.then(cached)]);
    if (first) return first;
    // Timed out with nothing cached (or the network failed): keep waiting for the network.
    return await net;
  } catch {
    return (await cached()) || Response.error();
  }
}

/**
 * The app itself (scripts, styles, the word index, entry text): ask the network first. The browser's own HTTP
 * cache answers in a few milliseconds, and the Cache Storage copy is only the offline fallback. It is never
 * consulted while the network answers, because on a phone with word packs installed that is the slow part.
 */
async function assetFirst(event, req) {
  if (self.navigator && self.navigator.onLine === false) {
    const hit = await lookup(req);
    if (hit) return hit;
  }
  const net = fetch(req).then((res) => {
    saveLater(event, req.url, res);
    return res;
  });
  const wait = new Promise((resolve) => setTimeout(resolve, ASSET_WAIT, null));
  try {
    const first = await Promise.race([net.catch(() => null), wait.then(() => lookup(req))]);
    if (first) return first;
    return await net;
  } catch {
    return (await lookup(req)) || Response.error();
  }
}

async function cacheFirst(req) {
  const range = req.headers.get("range");
  const hit = await lookup(req);
  if (hit) return range ? sliceResponse(hit, range) : hit;
  // Audio on iOS asks for byte ranges. These files are small, so fetch the whole file once,
  // keep it, and answer the range from it; later plays (and offline use) then work.
  const isAudio = /\/atlas\/audio\//.test(req.url);
  const res = await fetch(range && isAudio ? req.url : req);
  if (range && !isAudio) return res; // other partial answers are never stored
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    const url = new URL(req.url);
    const name = isMediaUrl(url.pathname) ? MEDIA : SHELL;
    caches
      .open(name)
      .then((c) => c.put(req.url, copy))
      .then(() => name === MEDIA && trim(MEDIA, 1500));
  }
  return range && res.status === 200 ? sliceResponse(res, range) : res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !req.url.startsWith(self.registration.scope)) return;
  const isPage = req.mode === "navigate";
  event.respondWith(isPage ? networkFirst(event, req) : isMediaUrl(req.url) ? cacheFirst(req) : assetFirst(event, req));
});
