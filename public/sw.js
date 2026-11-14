/* 非莫离线服务。
 * - 页面：优先联网（1.5 秒没回应就用本机缓存），所以信号差也能快速打开。
 * - 词库目录 index.json：先用本机缓存立刻显示，同时在后台更新，下次打开就是新的。
 * - 其余文件（插画、发音、词条、脚本）：本机有就直接用，没有再联网并记住。
 * - 单词包写入的 phemor-packs 缓存永远不会被这里清理，只能在 App 里移除。
 * - 支持 Range 请求：iPhone 播放音频必须靠它，否则离线时发音会失效。 */
const VERSION = "atlas-v2";
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;
const PACKS = "phemor-packs";
const NETWORK_WAIT = 1500;

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

async function lookup(req) {
  // Word packs first, then everything else we have cached.
  const packs = await caches.open(PACKS);
  return (await packs.match(req.url)) || (await caches.match(req.url));
}

async function networkFirst(req) {
  const cached = () => lookup(req).then((hit) => hit || caches.match(new URL("./", self.registration.scope).href));
  const net = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req.url, copy));
    }
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

async function staleWhileRevalidate(event, req) {
  const hit = await lookup(req);
  const net = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req.url, copy));
    }
    return res;
  });
  if (hit) {
    event.waitUntil(net.catch(() => null));
    return hit;
  }
  return net;
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
    const name = /\/atlas\/(img|thumb|audio)\//.test(url.pathname) ? MEDIA : SHELL;
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
  const isIndex = url.pathname.endsWith("/atlas/index.json");
  event.respondWith(isPage ? networkFirst(req) : isIndex ? staleWhileRevalidate(event, req) : cacheFirst(req));
});
