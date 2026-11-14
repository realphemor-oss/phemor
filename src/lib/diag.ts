import { idbCountFiles, idbGet } from "../packs/idb";
import { PACK_CACHE, SHELL_CACHE } from "../packs/spec";

/** Start-up timings, so a slow launch on a real phone can be read instead of guessed at. Nothing leaves the device. */
const marks: [string, number][] = [];
export const mark = (name: string) => {
  marks.push([name, Math.round(performance.now())]);
};

const ms = (n: number) => `${Math.round(n)} ms`;

async function timed<T>(label: string, out: string[], fn: () => Promise<T>) {
  const t = performance.now();
  try {
    await fn();
    out.push(`${label}：${ms(performance.now() - t)}`);
  } catch (e) {
    out.push(`${label}：出错 ${(e as Error).message}`);
  }
}

/** Times the cache and database calls the start-up depends on, one after another. */
export async function probe() {
  const out: string[] = [];
  if (typeof caches === "undefined") return ["这个浏览器没有 Cache Storage"];
  const base = import.meta.env.BASE_URL;
  const idx = new URL(`${base}atlas/index.json`, location.origin).href;
  await timed("列出全部缓存", out, () => caches.keys());
  await timed("打开 App 自己的缓存并查词库目录", out, async () => (await caches.open(SHELL_CACHE)).match(idx));
  await timed("打开单词包缓存并查一个文件", out, async () => (await caches.open(PACK_CACHE)).match(new URL(`${base}atlas/thumb/.probe`, location.origin).href));
  await timed("再次查 App 自己的缓存", out, async () => (await caches.open(SHELL_CACHE)).match(idx));
  await timed("打开本地数据库（单词包记录）", out, () => new Promise<void>((res, rej) => {
    const r = indexedDB.open("phemor-packs");
    r.onsuccess = () => (r.result.close(), res());
    r.onerror = () => rej(r.error);
  }));
  let count = 0;
  await timed("数据库：数一数单词包文件", out, async () => (count = await idbCountFiles()));
  out.push(`数据库里的单词包文件：${count} 个（0 个表示单词包还是旧格式，重装后会变快）`);
  const probeFile = new URL(`${base}atlas/thumb/.probe`, location.origin).href;
  await timed("数据库：读一个文件", out, () => idbGet(probeFile, "files"));
  return out;
}

export function report() {
  const lines: string[] = [];
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  lines.push(`设备：${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 90)}`);
  lines.push(`离线服务：${navigator.serviceWorker?.controller ? "已接管" : "未接管"}`);
  if (nav) {
    lines.push("— 页面加载（从点开图标算起）—");
    lines.push(`开始取页面 ${ms(nav.fetchStart)}，收到页面 ${ms(nav.responseStart)}，页面读完 ${ms(nav.responseEnd)}`);
    lines.push(`脚本就绪 ${ms(nav.domInteractive)}，全部加载 ${ms(nav.loadEventEnd)}`);
  }
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  if (fcp) lines.push(`第一次出现内容：${ms(fcp.startTime)}`);
  lines.push("— App 内部节点 —");
  for (const [n, t] of marks) lines.push(`${n}：${t} ms`);
  const res = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((r) => r.duration > 150)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 8);
  if (res.length) {
    lines.push("— 最慢的几个文件（耗时>150ms）—");
    for (const r of res) lines.push(`${r.name.split("/").slice(-2).join("/").slice(0, 38)}：从 ${ms(r.startTime)} 起，用了 ${ms(r.duration)}`);
  }
  return lines;
}
