import { BookOpen, ChevronLeft, ChevronRight, Compass, Github, Keyboard, Moon, Search, Sun, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { armCues } from "./lib/sound";
import { AtlasContext, useAtlas, useEntry } from "./atlas/context";
import { loadOpenAtlas, loadPrivateAtlas, warmEntries } from "./atlas/data";
import { loadExtras, loadExtrasStaged, PACKS_CHANGED, syncLegacyFlag } from "./packs/install";
import type { Atlas } from "./atlas/types";
import { REPO_URL } from "./config";
import { closeWord, currentLocation, go, openWord, useLocation, type Route } from "./lib/router";
import { AtlasPage } from "./pages/Atlas";
import { About } from "./pages/About";
import { Learn } from "./pages/Learn";
import { Me } from "./pages/Me";
import { Onboarding } from "./pages/Onboarding";
import { InstallGuide, Packs } from "./pages/Packs";
import { Practice } from "./pages/Practice";
import { Confusables, Paraphrase } from "./pages/PracticeModules";
import { Today } from "./pages/Today";
import { cue } from "./lib/sound";
import { store, useStore } from "./store/store";
import { EntryView } from "./ui/EntryView";
import { Logo } from "./ui/Logo";
import { Palette } from "./ui/Palette";
import { Sheet } from "./ui/Sheet";
import { ContactMail } from "./ui/ContactMail";
import { Toasts } from "./ui/Toast";
import { mark } from "./lib/diag";

const NAV: { page: Route["page"]; label: string; icon: typeof Compass }[] = [
  { page: "today", label: "今日", icon: Compass },
  { page: "atlas", label: "图鉴", icon: BookOpen },
  { page: "practice", label: "练习", icon: Keyboard },
  { page: "me", label: "我的", icon: User },
];

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0D1120" : "#F6F1E7");
  }, [theme]);
  return theme;
}

export default function App() {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [open, setOpen] = useState<Atlas | null>(null);
  const [priv, setPriv] = useState<Atlas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dataset = useStore((s) => s.settings.dataset);
  useTheme();

  useEffect(() => {
    let live = true;
    let first = true;
    // Bumped whenever the packs change, so an unfinished start-up pass stops and the full reload wins.
    let round = 0;
    const apply = (a: Atlas) => {
      if (!live) return;
      setOpen(a);
      if (first && import.meta.env.DEV) loadPrivateAtlas(a).then(setPriv, () => null);
      first = false;
    };
    // A pack was added or removed (or any later reload): rebuild the word list with every pack at once.
    const load = () => {
      round++;
      return loadOpenAtlas(loadExtras).then(apply, (e: Error) => live && first && setError(e.message));
    };
    // Start-up: show the app first with the built-in words, then add the free pack, then the others.
    const start = async () => {
      mark("App 开始读词库");
      const mine = ++round;
      let base: Atlas;
      try {
        base = await loadOpenAtlas();
      } catch (e) {
        if (live) setError((e as Error).message);
        return;
      }
      if (!live || mine !== round) return;
      mark("内置词库已读到，开始显示");
      apply(base);
      await loadExtrasStaged(
        base.topics.length,
        base.cefr.length,
        async (extras) => {
          const a = await loadOpenAtlas(async () => extras);
          if (live && mine === round) {
            mark(`已加入单词包（累计 ${extras.rows.length} 个词）`);
            apply(a);
          }
        },
        () => !live || mine !== round,
      ).catch(() => null);
      void syncLegacyFlag();
    };
    void start();
    // Once the app is up and the offline worker is in charge, quietly save all entry text.
    const flag = { cancelled: false };
    const warm = window.setTimeout(() => void warmEntries(flag).catch(() => null), 4000);
    const again = () => void load();
    window.addEventListener(PACKS_CHANGED, again);
    return () => {
      live = false;
      flag.cancelled = true;
      window.clearTimeout(warm);
      window.removeEventListener(PACKS_CHANGED, again);
    };
  }, []);

  useEffect(() => {
    const next = dataset === "private" && priv ? priv : open;
    if (next && next !== atlas) {
      // Reload saved progress only when the dataset itself changes, not at each stage of loading packs.
      if (!atlas || atlas.id !== next.id) store.useDataset(next.id);
      setAtlas(next);
    }
  }, [dataset, open, priv, atlas]);

  if (error)
    return (
      <div className="boot">
        <Logo />
        <p>{error}</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    );
  if (!atlas)
    return (
      <div className="boot" aria-busy="true">
        <Logo />
        <span className="spinner" />
      </div>
    );
  return (
    <AtlasContext.Provider value={atlas}>
      <Shell privateAvailable={!!priv} />
    </AtlasContext.Provider>
  );
}

function Shell({ privateAvailable }: { privateAvailable: boolean }) {
  const { route, word } = useLocation();
  const onboarded = useStore((s) => s.settings.onboarded);
  const theme = useStore((s) => s.settings.theme);
  const [palette, setPalette] = useState(false);
  useEffect(() => armCues(), []);
  const focus = route.page === "learn";

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "/" && !typing && !focus) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [focus]);

  useEffect(() => {
    if (!word) window.scrollTo({ top: 0 });
  }, [route.page]); // eslint-disable-line react-hooks/exhaustive-deps

  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <div className={`app ${focus ? "is-focus" : ""}`}>
      {!focus && (
        <header className="topbar">
          <a className="topbar-logo" href="#/" aria-label="非莫 phemor 首页">
            <Logo />
          </a>
          <nav className="topnav" aria-label="主导航">
            {NAV.map(({ page, label }) => (
              <a key={page} href={page === "today" ? "#/" : `#/${page}`} className={(route.page === page || (page === "practice" && (route.page === "paraphrase" || route.page === "confuse"))) ? "is-on" : ""} aria-current={route.page === page || (page === "practice" && (route.page === "paraphrase" || route.page === "confuse")) ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          <div className="topbar-tools">
            <button className="search-pill" onClick={() => setPalette(true)} aria-label="搜索单词">
              <Search size={17} />
              <span>搜索单词</span>
              <kbd>⌘K</kbd>
            </button>
            <button className="icon-btn" onClick={() => store.settings({ theme: dark ? "light" : "dark" })} aria-label={dark ? "切换到浅色" : "切换到深色"}>
              {dark ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <a className="icon-btn hide-sm" href="#/about" aria-label="关于与开源" title="关于与开源">
              <Github size={19} />
            </a>
          </div>
        </header>
      )}

      <main className="main" id="main">
        {route.page === "today" && <Today />}
        {route.page === "atlas" && <AtlasPage route={route} />}
        {route.page === "learn" && <Learn />}
        {route.page === "practice" && <Practice />}
        {route.page === "paraphrase" && <Paraphrase />}
        {route.page === "confuse" && <Confusables />}
        {route.page === "me" && <Me privateAvailable={privateAvailable} />}
        {route.page === "packs" && <Packs route={route} />}
        {route.page === "install" && <InstallGuide />}
        {route.page === "about" && <About />}
      </main>

      {!focus && (
        <footer className="footer">
          <Logo compact />
          <ContactMail label="联系我们" subject="非莫 phemor 咨询" />
          <p>
            一词一画，点亮雅思 · 免费开源 ·{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>{" "}
            · <a href="#/about">关于</a>
          </p>
        </footer>
      )}

      {!focus && (
        <nav className="tabbar" aria-label="主导航">
          {NAV.map(({ page, label, icon: Icon }) => (
            <a key={page} href={page === "today" ? "#/" : `#/${page}`} className={(route.page === page || (page === "practice" && (route.page === "paraphrase" || route.page === "confuse"))) ? "is-on" : ""} aria-current={route.page === page || (page === "practice" && (route.page === "paraphrase" || route.page === "confuse")) ? "page" : undefined}>
              <Icon size={22} strokeWidth={route.page === page ? 2.1 : 1.7} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
      )}

      <WordSheet id={word} />
      <Palette open={palette} onClose={() => setPalette(false)} />
      {!onboarded && route.page !== "about" && <Onboarding />}
      <Toasts />
    </div>
  );
}

function WordSheet({ id }: { id: string | null }) {
  const atlas = useAtlas();
  const opened = id !== null;
  useEffect(() => {
    if (opened && store.get().settings.sfx) void cue("page");
  }, [opened]);
  const { entry, error } = useEntry(id);
  const ref = id ? atlas.byId.get(id) : undefined;
  const neighbor = useCallback(
    (d: number) => {
      if (!ref) return;
      const n = atlas.words[ref.order + d];
      if (n) go(currentLocation().route, n.id, true);
    },
    [atlas, ref],
  );
  useEffect(() => {
    if (!id) return;
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowLeft") neighbor(-1);
      if (e.key === "ArrowRight") neighbor(1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [id, neighbor]);
  return (
    <Sheet open={!!id} onClose={closeWord} label={ref ? `${ref.word} 词条` : "词条"} wide>
      {entry ? (
        <EntryView key={entry.id} entry={entry} />
      ) : error ? (
        <p className="sheet-error">{error}</p>
      ) : (
        <span className="spinner" />
      )}
      {ref && (
        <nav className="sheet-nav" aria-label="切换词条">
          <button className="icon-btn" onClick={() => neighbor(-1)} disabled={ref.order === 0} aria-label="上一个">
            <ChevronLeft size={20} />
          </button>
          <span>
            {(ref.order + 1).toLocaleString()} / {atlas.count.toLocaleString()}
          </span>
          <button className="icon-btn" onClick={() => neighbor(1)} disabled={ref.order >= atlas.count - 1} aria-label="下一个">
            <ChevronRight size={20} />
          </button>
        </nav>
      )}
    </Sheet>
  );
}

export { openWord };
