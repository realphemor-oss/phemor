import {
  CheckCircle2,
  Copy,
  Download,
  FolderOpen,
  Link2,
  Share,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAtlas } from "../atlas/context";
import { PACK_CATALOG, PACK_SHARE } from "../config";
import { go, type Route } from "../lib/router";
import {
  downloadPack,
  fetchCatalog,
  installPack,
  listInstalled,
  PACKS_CHANGED,
  removePack,
  requestPersist,
  storageInfo,
  supportsPacks,
  type CatalogItem,
  type InstalledPack,
  type Progress,
} from "../packs/install";
import {
  appLink,
  canPromptInstall,
  copyText,
  detectEnv,
  onInstallChange,
  promptInstall,
} from "../packs/pwa";

const shareUrl = (() => {
  try {
    const u = new URL(PACK_SHARE.url);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
})();
import { PackError } from "../packs/spec";
import { toast } from "../ui/Toast";
import { LicensePanel } from "./LicensePanel";

const mb = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(n / 1e6))} MB`;
const CATALOG_KEY = "phemor:catalog";

function useInstalled() {
  const [list, setList] = useState<InstalledPack[]>([]);
  const refresh = useCallback(
    () => listInstalled().then(setList, () => setList([])),
    [],
  );
  useEffect(() => {
    void refresh();
    window.addEventListener(PACKS_CHANGED, refresh);
    return () => window.removeEventListener(PACKS_CHANGED, refresh);
  }, [refresh]);
  return list;
}

/** A pack the learner asked for by link: shown for confirmation, never fetched automatically. */
function safeUrl(raw: string | undefined) {
  if (!raw) return null;
  try {
    const u = new URL(raw, location.href);
    if (u.protocol !== "https:" && u.origin !== location.origin) return null;
    return u;
  } catch {
    return null;
  }
}

export function Packs({ route }: { route: Extract<Route, { page: "packs" }> }) {
  const atlas = useAtlas();
  const installed = useInstalled();
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [catalogUrl, setCatalogUrl] = useState(() => {
    try {
      return localStorage.getItem(CATALOG_KEY) || PACK_CATALOG;
    } catch {
      return PACK_CATALOG;
    }
  });
  const [busy, setBusy] = useState<{
    label: string;
    progress: Progress | null;
  } | null>(null);
  const [info, setInfo] = useState<{
    usage: number;
    quota: number;
    persisted: boolean;
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const incoming = safeUrl(route.url);
  const [env] = useState(detectEnv);
  const supported = supportsPacks();
  const controlled =
    typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;

  useEffect(() => {
    let live = true;
    setCatalog(null);
    const u = safeUrl(catalogUrl);
    if (!u) return;
    fetchCatalog(u.href).then(
      (c) => live && setCatalog(c),
      () => live && setCatalog([]),
    );
    return () => {
      live = false;
    };
  }, [catalogUrl]);
  useEffect(() => {
    void storageInfo().then(setInfo);
  }, [installed]);

  const run = async (
    label: string,
    job: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (busy) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy({ label, progress: null });
    try {
      await job(ctl.signal);
    } catch (e) {
      toast(
        e instanceof PackError
          ? e.message
          : e instanceof Error
            ? e.message
            : "出错了，请重试。",
        "warn",
      );
    } finally {
      abort.current = null;
      setBusy(null);
    }
  };

  const setProgress = (progress: Progress) =>
    setBusy((b) => (b ? { ...b, progress } : b));

  const doInstall = async (blob: Blob, name: string, signal: AbortSignal) => {
    const rec = await installPack(blob, {
      topics: atlas.topics.length,
      levels: atlas.cefr.length,
      onProgress: setProgress,
      signal,
    });
    toast(`已添加「${rec.manifest.name || name}」`, "ok");
  };

  const fromFiles = (files: FileList) =>
    run("读取单词包", async (signal) => {
      for (const f of Array.from(files)) {
        setBusy({ label: `正在添加 ${f.name}`, progress: null });
        await doInstall(f, f.name, signal);
      }
    });

  const fromUrl = (items: { name: string; url: string }[]) =>
    run("下载单词包", async (signal) => {
      for (const it of items) {
        setBusy({ label: `正在下载 ${it.name}`, progress: null });
        const blob = await downloadPack(it.url, {
          onProgress: setProgress,
          signal,
        });
        setBusy({ label: `正在添加 ${it.name}`, progress: null });
        await doInstall(blob, it.name, signal);
      }
    });

  const useCatalog = async (href: string) => {
    try {
      localStorage.setItem(CATALOG_KEY, href);
    } catch {
      /* ignore */
    }
    setCatalogUrl(href);
    toast("已切换单词包目录", "ok");
  };

  const byId = new Map(installed.map((p) => [p.id, p]));
  const todo = (catalog ?? []).filter(
    (c) => (byId.get(c.id)?.manifest.version ?? 0) < c.version,
  );
  const todoBytes = todo.reduce((n, c) => n + c.bytes, 0);
  const catalogIds = new Set((catalog ?? []).map((c) => c.id));
  const total = installed.reduce((n, p) => n + p.bytes, 0);
  const pct =
    busy?.progress && busy.progress.total
      ? Math.round((busy.progress.done / busy.progress.total) * 100)
      : null;

  return (
    <div className="page packs">
      <header className="page-head">
        <p className="eyebrow">离线学习</p>
        <h1 className="display">单词包</h1>
        <p className="muted packs-lede">
          把插画和发音存进手机，之后不用联网，打开就是秒开。新词也是一个单词包，添加后自动加入你的学习路线，学习进度不受影响。
        </p>
      </header>

      {busy && (
        <section className="panel packs-busy" role="status" aria-live="polite">
          <p>
            <b>{busy.label}</b>
          </p>
          <progress max={100} value={pct ?? undefined} />
          <p className="muted">
            {busy.progress
              ? busy.progress.phase === "download"
                ? `已下载 ${mb(busy.progress.done)}${busy.progress.total ? ` / ${mb(busy.progress.total)}` : ""}`
                : `写入手机 ${busy.progress.done.toLocaleString()} / ${busy.progress.total.toLocaleString()}`
              : "请保持此页面打开，不要锁屏…"}
          </p>
          <button
            className="btn btn-ghost"
            onClick={() => abort.current?.abort()}
          >
            取消
          </button>
        </section>
      )}

      {!supported && (
        <section className="panel packs-warn">
          <p>
            <b>这个浏览器暂时不能保存离线单词包。</b>
            请用 iPhone 的 Safari，或安卓的 Chrome /
            系统浏览器打开本页（网址要以 https 开头）。
          </p>
        </section>
      )}

      {incoming && (
        <section className="panel packs-incoming">
          <h3 className="eyebrow">
            {incoming.pathname.endsWith(".json")
              ? "有人给你发了一个单词包目录"
              : "有人给你发了一个单词包"}
          </h3>
          <p className="muted">来自 {incoming.host}。只添加你信任的来源。</p>
          {incoming.pathname.endsWith(".json") ? (
            <button
              className="btn btn-primary"
              onClick={() =>
                useCatalog(incoming.href).then(() =>
                  go({ page: "packs" }, null, true),
                )
              }
            >
              <Link2 size={18} /> 使用这个目录
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!!busy || !supported}
              onClick={() =>
                fromUrl([
                  {
                    name: incoming.pathname.split("/").pop() || "单词包",
                    url: incoming.href,
                  },
                ]).then(() => go({ page: "packs" }, null, true))
              }
            >
              <Download size={18} /> 下载并添加
            </button>
          )}
        </section>
      )}

      {shareUrl && (
        <section className="panel packs-share">
          <h3 className="eyebrow">第一步 · 去{PACK_SHARE.name}下载</h3>
          <p>
            按你的阶段选包下载：<b>初中包</b>、<b>高中包</b>、<b>大学包</b>、
            <b>雅思进阶包</b>、<b>旅游包</b>
            。后一个包不含前一个包的词，想学几个就下几个，建议连 Wi-Fi。
          </p>
          <div className="packs-actions">
            <a
              className="btn btn-primary"
              href={shareUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={18} /> 打开{PACK_SHARE.name}
            </a>
            {PACK_SHARE.code && (
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void copyText(PACK_SHARE.code).then((ok) =>
                    toast(
                      ok ? "提取码已复制" : "请手动记下提取码",
                      ok ? "ok" : "warn",
                    ),
                  )
                }
              >
                <Copy size={18} /> 提取码 {PACK_SHARE.code}
              </button>
            )}
          </div>
          <p className="muted packs-tip">
            下载完成后，把文件保存到手机「文件」（iPhone：点文件 → 分享 →
            存储到“文件”）或下载文件夹（安卓），然后回到这里，在下面「第二步」选择它。
          </p>
        </section>
      )}

      <LicensePanel
        packNames={Object.fromEntries(
          (catalog ?? []).map((c) => [c.id, c.name]),
        )}
      />

      <div className="packs-grid">
        <section className="panel">
          <h3 className="eyebrow">我的离线状态</h3>
          <ul className="packs-status">
            <li className={env.standalone ? "ok" : ""}>
              <Smartphone size={18} />
              <span>
                {env.standalone
                  ? "已添加到主屏幕，像 App 一样使用"
                  : "还没添加到主屏幕"}
              </span>
              {!env.standalone && (
                <a className="link" href="#/install">
                  怎么添加
                </a>
              )}
            </li>
            <li className={controlled ? "ok" : ""}>
              <CheckCircle2 size={18} />
              <span>
                {controlled ? "离线模式已开启" : "离线模式将在第二次打开时开启"}
              </span>
            </li>
            <li className={installed.length ? "ok" : ""}>
              <Download size={18} />
              <span>
                {installed.length
                  ? `已添加 ${installed.length} 个单词包，占用 ${mb(total)}`
                  : "还没有添加单词包，现在联网浏览会比较慢"}
              </span>
            </li>
          </ul>
          {info && info.quota > 0 && !info.persisted && (
            <p className="muted">
              <button
                className="link"
                onClick={() =>
                  requestPersist().then(
                    (ok) => (
                      toast(
                        ok
                          ? "已申请永久保存"
                          : "浏览器暂未同意，添加到主屏幕后更稳",
                      ),
                      storageInfo().then(setInfo)
                    ),
                  )
                }
              >
                防止被系统清理
              </button>
            </p>
          )}
        </section>

        <section className="panel">
          <h3 className="eyebrow">
            {shareUrl ? "第二步 · 添加单词包" : "添加单词包"}
          </h3>
          <div className="packs-actions">
            <button
              className="btn btn-primary"
              disabled={!!busy || !supported}
              onClick={() => file.current?.click()}
            >
              <FolderOpen size={18} /> 选择单词包文件
            </button>
            <input
              ref={file}
              type="file"
              multiple
              hidden
              onChange={(e) =>
                e.target.files?.length &&
                void fromFiles(e.target.files).finally(
                  () => (e.target.value = ""),
                )
              }
            />
          </div>
          <p className="muted packs-tip">
            朋友或老师发来的 <code>.phemor</code>{" "}
            文件：先在微信里点开它，选「保存到手机 /
            用其他应用打开」存到「文件」，再回到这里选择它。
          </p>
          {shareUrl && (
            <div className="packs-link">
              <span className="muted">或者复制链接，在浏览器打开下载</span>
              <div>
                <a
                  className="link packs-link-url"
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shareUrl}
                </a>
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    void copyText(shareUrl).then((ok) =>
                      toast(
                        ok ? "链接已复制" : "请长按链接手动复制",
                        ok ? "ok" : "warn",
                      ),
                    )
                  }
                >
                  <Copy size={18} /> 复制
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {(catalog === null || catalog.length > 0 || !shareUrl) && (
        <section className="panel packs-list">
          <div className="panel-head">
            <h3 className="eyebrow">在线单词包</h3>
            {todo.length > 1 && (
              <button
                className="btn btn-primary"
                disabled={!!busy || !supported}
                onClick={() =>
                  confirm(
                    `将依次下载 ${todo.length} 个单词包，共约 ${mb(todoBytes)}。建议在 Wi-Fi 下进行，继续吗？`,
                  ) &&
                  void fromUrl(todo.map((c) => ({ name: c.name, url: c.url })))
                }
              >
                <Download size={18} /> 全部下载（{mb(todoBytes)}）
              </button>
            )}
          </div>
          {catalog === null ? (
            <span className="spinner" />
          ) : catalog.length === 0 ? (
            <p className="muted">
              暂时没有在线目录。你可以用上面的方式添加文件或链接。
            </p>
          ) : (
            <ol className="pack-rows">
              {catalog.map((c, i) => {
                const have = byId.get(c.id);
                const outdated = have && have.manifest.version < c.version;
                return (
                  <li key={c.id} className={have && !outdated ? "is-done" : ""}>
                    {c.group && c.group !== catalog[i - 1]?.group && (
                      <h4 className="pack-group">{c.group}</h4>
                    )}
                    <div className="pack-row">
                      <div>
                        <b>{c.name}</b>
                        <small>
                          {c.words ? `${c.words.toLocaleString()} 词 · ` : ""}
                          {mb(c.bytes)}
                          {c.description ? ` · ${c.description}` : ""}
                        </small>
                      </div>
                      {have && !outdated ? (
                        <span className="chip-ok">
                          <CheckCircle2 size={16} /> 已添加
                        </span>
                      ) : (
                        <button
                          className="btn btn-ghost"
                          disabled={!!busy || !supported}
                          onClick={() =>
                            void fromUrl([{ name: c.name, url: c.url }])
                          }
                        >
                          <Download size={16} /> {outdated ? "更新" : "下载"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      {installed.some((p) => !catalogIds.has(p.id)) || installed.length ? (
        <section className="panel packs-list">
          <h3 className="eyebrow">已添加</h3>
          <ol className="pack-rows">
            {installed.map((p) => (
              <li key={p.id}>
                <div className="pack-row">
                  <div>
                    <b>{p.manifest.name}</b>
                    <small>
                      v{p.manifest.version} · {mb(p.bytes)}
                      {p.rows.length ? ` · 新增/更新 ${p.rows.length} 词` : ""}
                    </small>
                  </div>
                  <button
                    className="btn btn-ghost btn-danger"
                    disabled={!!busy}
                    onClick={() =>
                      confirm(
                        `移除「${p.manifest.name}」？学习进度不会丢，图片和发音会回到联网加载。`,
                      ) && void removePack(p.id).then(() => toast("已移除"))
                    }
                  >
                    <Trash2 size={16} /> 移除
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

/** Step-by-step "add to home screen" for the three situations Chinese learners are actually in. */
export function InstallGuide() {
  const [env] = useState(detectEnv);
  const [tab, setTab] = useState<"wechat" | "ios" | "android">(
    env.inApp ? "wechat" : env.ios ? "ios" : "android",
  );
  const [, tick] = useState(0);
  useEffect(() => onInstallChange(() => tick((n) => n + 1)), []);
  const link = appLink();
  const copy = () =>
    void copyText(link).then((ok) =>
      toast(
        ok ? "链接已复制，去浏览器粘贴打开" : "请长按地址栏手动复制",
        ok ? "ok" : "warn",
      ),
    );

  return (
    <div className="page packs">
      <header className="page-head">
        <p className="eyebrow">像 App 一样使用</p>
        <h1 className="display">添加到主屏幕</h1>
        <p className="muted packs-lede">
          不用下载安装包，也不占应用商店。添加后桌面多一个「非莫」图标，点开就能学，配合单词包可以完全离线。
        </p>
      </header>

      {env.standalone && (
        <section className="panel packs-ok">
          <p>
            <CheckCircle2 size={18} /> <b>你已经在使用主屏幕版了。</b>
          </p>
          <button
            className="btn btn-primary"
            onClick={() => go({ page: "packs" })}
          >
            去添加单词包
          </button>
        </section>
      )}

      <div className="segmented segmented-wide install-tabs" role="tablist">
        {(
          [
            ["wechat", "我在微信里"],
            ["ios", "iPhone"],
            ["android", "安卓"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "is-on" : ""}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>

      <section className="panel install-steps">
        {tab === "wechat" && (
          <>
            <p className="install-note">
              微信自带的浏览器不能添加到主屏幕，也存不下离线内容。请先换成手机自带浏览器打开：
            </p>
            <ol>
              <li>
                点右上角「<b>···</b>」
              </li>
              <li>
                选「<b>在默认浏览器打开</b>」（iPhone 是「在 Safari 中打开」）
              </li>
              <li>打开后，再按「iPhone」或「安卓」页签继续</li>
            </ol>
            <p className="muted">
              如果没有这个选项，复制下面的链接，到浏览器地址栏粘贴打开。
            </p>
            <button className="btn btn-primary" onClick={copy}>
              <Copy size={18} /> 复制链接
            </button>
          </>
        )}
        {tab === "ios" && (
          <>
            {!env.iosSafari && env.ios && (
              <p className="install-note">
                请先用 <b>Safari</b> 打开本页（其他浏览器可能没有添加入口）。
              </p>
            )}
            <ol>
              <li>
                点 Safari 的「<b>分享</b>」按钮{" "}
                <Share size={16} className="inline-ico" />
                （旧版 iOS 在底部中间；新版 iOS 在地址栏右边的「<b>···</b>」里）
              </li>
              <li>
                在分享菜单里向上滑动，选「<b>添加到主屏幕</b>」
              </li>
              <li>
                确认「<b>作为网页 App 打开</b>」是<b>开启（绿色）</b>
                的，再点右上角「<b>添加</b>」，桌面就有「非莫」了
              </li>
            </ol>
            <p className="muted">
              以后从桌面图标进入，iPhone 会长期保留你下载的内容；只在 Safari
              里用的话，一周不打开可能被系统清理。
            </p>
          </>
        )}
        {tab === "android" && (
          <>
            {canPromptInstall() && (
              <button
                className="btn btn-primary"
                onClick={() => void promptInstall()}
              >
                <Smartphone size={18} /> 一键安装到手机
              </button>
            )}
            <ol>
              <li>
                用 <b>Chrome</b>、系统浏览器或夸克打开本页
              </li>
              <li>
                点右上角或底部菜单「<b>⋮</b>」
              </li>
              <li>
                选「<b>添加到主屏幕</b>」或「<b>安装应用</b>
                」（华为/小米：「添加到桌面」）
              </li>
            </ol>
            <p className="muted">
              如果提示「添加快捷方式」，也选确定，效果一样。
            </p>
          </>
        )}
      </section>

      <p className="packs-foot">
        <a className="link" href="#/packs">
          下一步：添加单词包 →
        </a>
      </p>
    </div>
  );
}
