import { ArrowRight, Check, Eye, Headphones, Keyboard, RotateCcw, Type, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { prefetch, useAtlas } from "../atlas/context";
import type { Entry } from "../atlas/types";
import { play, stopAudio } from "../lib/audio";
import { cue } from "../lib/sound";
import { hashSeed, shuffle } from "../lib/text";
import { clean, correctCharacterCount, same, typingDelta, typingMetrics } from "../lib/typing";
import { store, useStore } from "../store/store";
import { Illustration } from "../ui/Illustration";

type Mode = "word" | "sentence" | "dictation";
type Source = "recent" | "mistakes" | "saved" | "path";

const MODES: [Mode, string, string, typeof Type][] = [
  ["word", "单词", "看图写出单词", Type],
  ["sentence", "例句", "照着抄写，练出手感", Keyboard],
  ["dictation", "听写", "只听声音，写下整句", Headphones],
];
const SOURCES: [Source, string][] = [
  ["recent", "最近学过"],
  ["mistakes", "错词本"],
  ["saved", "收藏"],
  ["path", "学习路线"],
];

export function Practice() {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const startLevel = useStore((s) => s.settings.startLevel);
  const [mode, setMode] = useState<Mode>("word");
  const [source, setSource] = useState<Source>(() => (Object.keys(progress.cards).length ? "recent" : "path"));
  const [round, setRound] = useState<{ entries: Entry[]; key: number } | null>(null);

  const pool = useMemo(() => {
    const learned = Object.entries(progress.cards)
      .sort((a, b) => (b[1].last ?? 0) - (a[1].last ?? 0))
      .map(([id]) => id);
    const ids =
      source === "recent" ? learned : source === "mistakes" ? progress.mistakes : source === "saved" ? progress.bookmarks : atlas.words.filter((w) => w.cefr >= startLevel).slice(0, 400).map((w) => w.id);
    return ids.filter((id) => atlas.byId.has(id));
  }, [atlas, progress.cards, progress.mistakes, progress.bookmarks, source, startLevel]);

  const start = async () => {
    const ids = shuffle(pool.slice(0, 60), hashSeed(String(Date.now()))).slice(0, 10);
    const entries = (await prefetch(atlas, ids)).filter((e): e is Entry => !!e && (mode === "word" || e.ex.length > 0));
    if (entries.length) setRound({ entries, key: Date.now() });
  };

  if (round) return <TypingRound key={round.key} mode={mode} entries={round.entries} onExit={() => setRound(null)} onAgain={start} />;

  const best = progress.typing.filter((t) => t.mode === mode).reduce((m, t) => Math.max(m, t.wpm), 0);
  return (
    <div className="page practice">
      <header className="page-head">
        <p className="eyebrow">练习 · Typing Studio</p>
        <h1 className="display">让手，也记住它们。</h1>
        <p className="lede">打字只练拼写和手感，不会改动记忆进度。</p>
      </header>
      <div className="practice-grid">
        <section className="panel">
          <h3 className="eyebrow">模式</h3>
          <div className="mode-cards">
            {MODES.map(([k, name, desc, Icon]) => (
              <button key={k} className={`mode-card ${mode === k ? "is-on" : ""}`} onClick={() => setMode(k)} aria-pressed={mode === k}>
                <Icon size={22} strokeWidth={1.7} />
                <b>{name}</b>
                <small>{desc}</small>
              </button>
            ))}
          </div>
          <h3 className="eyebrow">词来自</h3>
          <div className="segmented segmented-wide">
            {SOURCES.map(([k, label]) => (
              <button key={k} className={source === k ? "is-on" : ""} onClick={() => setSource(k)} aria-pressed={source === k}>
                {label}
              </button>
            ))}
          </div>
          <p className="muted">
            {pool.length
              ? source === "path"
                ? "从学习路线的前 400 个词里随机抽 10 个。"
                : `可练 ${pool.length} 个词，每轮随机 10 个。`
              : "这里还没有词，先去学几个，或换个来源。"}
          </p>
          <button className="btn btn-primary btn-xl" onClick={start} disabled={!pool.length}>
            开始一轮
          </button>
        </section>
        <section className="panel practice-side">
          <img src={`${import.meta.env.BASE_URL}brand/${mode === "dictation" ? "listen" : "typing"}.webp`} alt="" />
          <dl className="mini-stats">
            <div>
              <dt>最佳速度</dt>
              <dd>
                {best}
                <small>WPM</small>
              </dd>
            </div>
            <div>
              <dt>完成轮次</dt>
              <dd>{progress.typing.length}</dd>
            </div>
          </dl>
          <p className="muted">WPM 按标准每 5 个字符计 1 词，只统计正确输入。</p>
        </section>
      </div>
      <section className="practice-modules" aria-labelledby="practice-modules-title">
        <p className="eyebrow">专项练习</p>
        <h2 id="practice-modules-title" className="display">把词用准。</h2>
        <a className="practice-module-link" href="#/paraphrase">
          <span><b>同义替换</b><small>在语境里选择意思相近的表达</small><em>开放词库 · 多题练习</em></span><ArrowRight aria-hidden="true" />
        </a>
        <a className="practice-module-link" href="#/confuse">
          <span><b>易混词辨析</b><small>分清拼写或含义容易混淆的词</small><em>基于词条用法提示整理</em></span><ArrowRight aria-hidden="true" />
        </a>
      </section>
    </div>
  );
}

function TypingRound({ mode, entries, onExit, onAgain }: { mode: Mode; entries: Entry[]; onExit: () => void; onAgain: () => void }) {
  const atlas = useAtlas();
  const settings = useStore((s) => s.settings);
  const [i, setI] = useState(0);
  const [value, setValue] = useState("");
  // Running totals live in a ref so every keystroke is counted exactly once.
  const totalsRef = useRef({ typed: 0, correct: 0, accepted: 0, ms: 0 });
  const [totals, setTotals] = useState(totalsRef.current);
  const [done, setDone] = useState(false);
  const [replayStatus, setReplayStatus] = useState<"idle" | "playing" | "error">("idle");
  const [playCount, setPlayCount] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [checked, setChecked] = useState<boolean | null>(null);
  const started = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const replayAudio = useRef<HTMLAudioElement>(null);
  const e = entries[i];
  const target = mode === "word" ? e.w : e.ex[0].en;

  useEffect(() => {
    setValue("");
    setReplayStatus("idle");
    setPlayCount(0);
    setShowHint(false);
    setShowAnswer(false);
    setChecked(null);
    replayAudio.current?.pause();
    replayAudio.current?.removeAttribute("src");
    replayAudio.current?.load();
    started.current = null;
    if (mode === "dictation") {
      void play(atlas.audio(e, "ex"), e.ex[0].en, settings.accent).then((result) => {
        if (result !== "unsupported" && result !== "stopped") setPlayCount((count) => count + 1);
      });
    } else input.current?.focus();
    if (mode === "word" && settings.autoplay) void play(atlas.audio(e, settings.accent), e.w, settings.accent);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    replayAudio.current?.pause();
    stopAudio();
  }, []);

  const onChange = (next: string) => {
    if (done) return;
    if (started.current === null && next) started.current = performance.now();
    const d = typingDelta(value, next, target);
    if (settings.sfx && d.total > 0) void cue("key");
    const t = totalsRef.current;
    totalsRef.current = { ...t, typed: t.typed + d.total, correct: t.correct + d.correct };
    setTotals(totalsRef.current);
    setValue(next);
    if (mode !== "dictation" && clean(next).length >= clean(target).length && same(next.trimEnd(), target)) finishItem(next);
  };

  const replaySentence = (event: MouseEvent<HTMLButtonElement>, rate = 1) => {
    event.preventDefault();
    event.stopPropagation();
    const audio = replayAudio.current;
    const url = atlas.audio(e, "ex");
    if (!audio || !url) {
      setReplayStatus("error");
      return;
    }
    stopAudio();
    audio.pause();
    audio.src = url;
    audio.volume = 1;
    audio.playbackRate = rate;
    audio.currentTime = 0;
    audio.onended = () => setReplayStatus("idle");
    audio.onerror = () => setReplayStatus("error");
    setReplayStatus("playing");
    try {
      void audio.play().then(() => {
        setPlayCount((count) => count + 1);
      }).catch(() => setReplayStatus("error"));
    } catch {
      setReplayStatus("error");
    }
  };

  const checkDictation = () => {
    const isCorrect = same(value.trim(), target.trim());
    setChecked(isCorrect);
    if (!isCorrect) setShowAnswer(true);
  };

  const finishItem = (final: string) => {
    const ms = started.current ? performance.now() - started.current : 0;
    const accepted = correctCharacterCount(final, target);
    if (settings.sfx) void cue("correct");
    const t = totalsRef.current;
    const nt = { ...t, accepted: t.accepted + accepted, ms: t.ms + ms };
    totalsRef.current = nt;
    setTotals(nt);
    if (i + 1 >= entries.length) {
      setDone(true);
      const m = typingMetrics(nt.correct, nt.typed, nt.accepted, nt.ms);
      store.progress((p) => ({ ...p, typing: [...p.typing, { at: Date.now(), mode, items: entries.length, wpm: m.wpm, accuracy: m.accuracy }].slice(-500) }));
    } else window.setTimeout(() => setI(i + 1), 260);
  };

  const m = typingMetrics(totals.correct, totals.typed, totals.accepted, totals.ms);
  const chars = Array.from(target);
  const typed = Array.from(value);

  if (done)
    return (
      <div className="page practice">
        <section className="panel typing-done">
          <p className="eyebrow">本轮完成</p>
          <h1 className="display">
            {m.wpm} <small>WPM</small>
          </h1>
          <p className="lede">准确率 {m.accuracy}% · {entries.length} 项</p>
          <div className="summary-actions">
            <button className="btn btn-ghost" onClick={onExit}>
              返回
            </button>
            <button className="btn btn-primary btn-xl" onClick={onAgain} autoFocus>
              <RotateCcw size={18} /> 再来一轮
            </button>
          </div>
        </section>
      </div>
    );

  if (mode === "dictation")
    return (
      <div className="page practice typing">
        <header className="typing-top">
          <button className="btn btn-ghost" onClick={onExit}>结束</button>
          <div className="learn-progress"><span style={{ width: `${(i / entries.length) * 100}%` }} /></div>
          <span className="typing-meter"><b>{m.wpm}</b> 词/分钟 · <b>{m.accuracy}%</b></span>
        </header>
        <section className="dictation-panel panel">
          <audio ref={replayAudio} preload="none" playsInline />
          <div className="dictation-audio-head">
            <p className="eyebrow">日常例句 · {settings.accent === "uk" ? "英音" : "美音"}</p>
            <strong>已播放 {playCount} 次</strong>
          </div>
          <button className="dictation-replay" onClick={(event) => replaySentence(event)} disabled={replayStatus === "playing"}>
            <RotateCcw size={25} />
            <span>{replayStatus === "playing" ? "正在播放" : replayStatus === "error" ? "播放失败，再试一次" : "再听一遍"}</span>
          </button>
          <div className="dictation-tools">
            <button className="btn btn-ghost" onClick={(event) => replaySentence(event, 0.75)} disabled={replayStatus === "playing"}>
              慢速播放 · 0.75 倍
            </button>
            <button className="btn btn-ghost" onClick={() => setShowHint((shown) => !shown)}>
              <Eye size={18} /> {showHint ? "隐藏中文提示" : "看中文提示"}
            </button>
          </div>
          {showHint && <p className="dictation-hint">{e.ex[0].zh}</p>}
          <p className="dictation-instruction">只听不看：写下你听到的整句话。</p>
          <textarea
            ref={textarea}
            className="dictation-answer"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder="输入听到的句子"
            aria-label="输入听到的句子"
          />
          <button className="btn btn-ghost dictation-action" onClick={() => setShowAnswer((shown) => !shown)}>
            {showAnswer ? "隐藏答案" : "看答案"}
          </button>
          {showAnswer && <p className="dictation-correct-answer" lang="en">{target}</p>}
          {checked === null ? (
            <button className="btn btn-primary btn-xl dictation-action" onClick={checkDictation} disabled={!value.trim()}>
              <Check size={18} /> 检查答案
            </button>
          ) : (
            <div className={`dictation-result ${checked ? "is-correct" : "is-wrong"}`}>
              <strong>{checked ? <><Check size={18} /> 完全正确</> : <><X size={18} /> 再对照答案练习</>}</strong>
              <button className="btn btn-primary btn-xl" onClick={() => finishItem(value)}>
                {i + 1 === entries.length ? "完成本轮" : "下一题"}<ArrowRight size={18} />
              </button>
            </div>
          )}
          {replayStatus === "error" && <p className="dictation-error" role="status">录音无法播放，请检查设备音量或稍后重试。</p>}
        </section>
      </div>
    );

  return (
    <div className="page practice typing">
      <header className="typing-top">
        <button className="btn btn-ghost" onClick={onExit}>
          结束
        </button>
        <div className="learn-progress">
          <span style={{ width: `${(i / entries.length) * 100}%` }} />
        </div>
        <span className="typing-meter">
          <b>{m.wpm}</b> WPM · <b>{m.accuracy}%</b>
        </span>
      </header>
      <section className="typing-stage" onClick={() => input.current?.focus()}>
        {mode === "word" && (
          <div className="typing-cue">
            <Illustration src={atlas.img(e)} word={e.w} topic={0} eager />
            <p>
              <span className="pos">{e.senses[0].pos}</span> {e.senses[0].zh}
            </p>
          </div>
        )}
        {mode !== "word" && (
          <p className="typing-zh">{e.ex[0].zh}</p>
        )}
        <p className={`typing-text ${mode === "word" ? "is-word" : ""}`} lang="en" aria-hidden="true">
          {chars.map((ch, k) => {
            const t = typed[k];
            const cls = t === undefined ? (k === typed.length ? "is-caret" : "") : same(t, ch) ? "is-ok" : "is-bad";
            return (
              <span key={k} className={cls}>
                {ch}
              </span>
            );
          })}
        </p>
        <input
          ref={input}
          className="typing-input"
          value={value}
          onChange={(ev) => onChange(ev.target.value)}
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="在这里输入"
        />
        <p className="muted typing-help">
          直接开始输入，全部正确后自动进入下一项。第 {i + 1}/{entries.length} 项
        </p>
      </section>
    </div>
  );
}
