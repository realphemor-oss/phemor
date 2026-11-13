import { ArrowLeft, ArrowRight, Check, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAtlas } from "../atlas/context";
import type { Entry } from "../atlas/types";
import { shuffle } from "../lib/text";

type SynonymQuestion = { entry: Entry; answer: string; options: string[] };
type ConfusableQuestion = { entry: Entry; other: Entry; options: string[] };

const ROUND_SIZE = 10;
const TARGET_SYNONYMS = 400;

// Built from common IELTS contrasts and the open atlas's usage notes.
const CONFUSABLE_PAIRS = [
  ["affect", "effect"], ["accept", "except"], ["advice", "advise"], ["adapt", "adopt"],
  ["assure", "ensure"], ["ensure", "insure"], ["economic", "economical"], ["historic", "historical"],
  ["emigrate", "immigrate"], ["personal", "personnel"], ["compliment", "complement"], ["stationary", "stationery"],
  ["sensible", "sensitive"], ["raise", "rise"], ["lay", "lie"], ["borrow", "lend"],
  ["fewer", "less"], ["then", "than"], ["beside", "besides"], ["continual", "continuous"],
  ["quiet", "quite"], ["desert", "dessert"], ["weather", "whether"], ["hear", "here"],
  ["peace", "piece"], ["weak", "week"], ["role", "roll"], ["later", "latter"],
  ["dairy", "diary"], ["career", "carrier"], ["sight", "site"], ["device", "devise"],
  ["discreet", "discrete"], ["ingenious", "ingenuous"], ["corporation", "cooperation"], ["exit", "exist"],
  ["stationer", "stationery"], ["textual", "textile"], ["forth", "fourth"], ["climactic", "climatic"],
  ["respective", "respectful"], ["accede", "exceed"], ["apprise", "appraise"], ["mayor", "major"],
  ["uninterested", "disinterested"], ["bathe", "bath"], ["burrow", "borrow"], ["appraisal", "approval"],
  ["clam", "calm"], ["descent", "decent"], ["prey", "pray"], ["terrific", "terrible"],
  ["prospective", "perspective"], ["vocation", "vacation"], ["principle", "principal"], ["conscious", "conscience"],
  ["elicit", "illicit"], ["magnate", "magnet"], ["predict", "prevent"], ["cloth", "clothes"],
  ["drought", "draught"], ["neck", "throat"], ["quietly", "quite"], ["consul", "consulate"],
  ["airway", "airline"], ["marshal", "martial"], ["tract", "track"], ["visible", "visual"],
  ["copyright", "patent"], ["lose", "loose"], ["flaunt", "flout"], ["allude", "elude"],
  ["principle", "principal"], ["counsellor", "councillor"], ["prospective", "perspective"], ["off", "of"],
].map(([a, b]) => [a, b] as const);

function sample<T>(items: T[], count: number) {
  return shuffle(items, Date.now() + Math.floor(Math.random() * 1_000_000)).slice(0, count);
}

function BackLink() {
  return <a className="practice-back" href="#/practice"><ArrowLeft size={17} /> 返回练习</a>;
}

export function Paraphrase() {
  const atlas = useAtlas();
  const [questions, setQuestions] = useState<SynonymQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [round, setRound] = useState<SynonymQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const pool: Entry[] = [];
        for (let offset = 0; offset < atlas.words.length && pool.length < TARGET_SYNONYMS; offset += 100) {
          const batch = await Promise.all(atlas.words.slice(offset, offset + 100).map((w) => atlas.entry(w.id)));
          pool.push(...batch.filter((entry) => entry.syn.length > 0));
        }
        if (cancelled) return;
        const distractors = [...new Set(pool.flatMap((entry) => [entry.w, ...entry.syn]))];
        const built = pool.slice(0, TARGET_SYNONYMS).flatMap((entry) => {
          const synonyms = [...new Set(entry.syn.filter((word) => word.toLowerCase() !== entry.w.toLowerCase()))];
          if (!synonyms.length) return [];
          const answer = synonyms[0];
          const wrong = sample(distractors.filter((word) => word !== answer && word.toLowerCase() !== entry.w.toLowerCase() && !synonyms.includes(word)), 3);
          return wrong.length === 3 ? [{ entry, answer, options: sample([answer, ...wrong], 4) }] : [];
        });
        setQuestions(built);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "词库加载失败，请刷新重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [atlas]);

  const current = round[index];
  const begin = () => {
    setRound(sample(questions, Math.min(ROUND_SIZE, questions.length)));
    setIndex(0); setScore(0); setSelected(null); setDone(false);
  };
  const choose = (word: string) => {
    if (selected || !current) return;
    setSelected(word);
    if (word === current.answer) setScore((value) => value + 1);
  };
  const next = () => {
    if (index + 1 >= round.length) setDone(true);
    else { setIndex((value) => value + 1); setSelected(null); }
  };

  if (loading) return <div className="page practice-module-page"><BackLink /><p className="eyebrow">同义替换</p><h1 className="display">让表达更灵活。</h1><section className="panel"><p>正在准备词库题目……</p></section></div>;
  if (loadError) return <div className="page practice-module-page"><BackLink /><p className="eyebrow">同义替换</p><section className="panel"><p>{loadError}</p></section></div>;

  return (
    <div className="page practice-module-page">
      <BackLink />
      <header className="page-head"><p className="eyebrow">练习 · 同义替换</p><h1 className="display">让表达更灵活。</h1><p className="lede">从开放词库中练习意思相近的表达。</p></header>
      {!questions.length ? <section className="panel"><p>当前词库没有可用的同义词题目。</p></section> : !round.length || done ? (
        <section className="panel module-start">
          {done ? <><p className="eyebrow">本轮完成</p><h2 className="display">{score} / {round.length}</h2><p className="lede">答对 {score} 题。</p></> : <><p className="eyebrow">题库</p><h2 className="display">{questions.length} 道题</h2><p className="lede">每轮随机练习 {Math.min(ROUND_SIZE, questions.length)} 题。答案来自词条中的同义词数据。</p></>}
          <button className="btn btn-primary btn-xl" onClick={begin}>{done ? <><RotateCcw size={18} /> 再练一轮</> : "开始练习"}</button>
        </section>
      ) : current ? (
        <section className="panel module-question">
          <div className="module-progress"><span>第 {index + 1} / {round.length} 题</span><span>本轮 {score} 分</span></div>
          <p className="eyebrow">选择意思最接近的词</p><h2 className="display">{current.entry.w}</h2>
          <p className="module-meaning">{current.entry.senses.map((sense) => sense.zh).join("；")}</p>
          {current.entry.ex[0] && <p className="module-example" lang="en">{current.entry.ex[0].en}</p>}
          <div className="module-choices">{current.options.map((option) => <button key={option} className={`module-choice ${selected === option ? option === current.answer ? "is-correct" : "is-wrong" : selected && option === current.answer ? "is-answer" : ""}`} onClick={() => choose(option)} disabled={!!selected}>{option}</button>)}</div>
          {selected && <div className={`module-feedback ${selected === current.answer ? "is-correct" : "is-wrong"}`}><b>{selected === current.answer ? <><Check size={18} /> 正确</> : <><X size={18} /> 正确答案：{current.answer}</>}</b><p>{current.entry.tip}</p><button className="btn btn-primary" onClick={next}>{index + 1 === round.length ? "查看成绩" : "下一题"}<ArrowRight size={17} /></button></div>}
        </section>
      ) : null}
    </div>
  );
}

export function Confusables() {
  const atlas = useAtlas();
  const pairs = useMemo(() => {
    const seen = new Set<string>();
    return CONFUSABLE_PAIRS.flatMap(([a, b]) => {
      const left = atlas.byId.get(a);
      const right = atlas.byId.get(b);
      const key = [a, b].sort().join("|");
      if (!left || !right || seen.has(key)) return [];
      seen.add(key);
      return [{ left, right }];
    });
  }, [atlas]);
  const [round, setRound] = useState<ConfusableQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const current = round[index];

  const begin = async () => {
    setLoading(true); setLoadError("");
    try {
      const batch = await Promise.all(pairs.flatMap(({ left, right }) => [atlas.entry(left.id), atlas.entry(right.id)]));
      const map = new Map(batch.map((entry) => [entry.id, entry]));
      setEntries(map);
      const qs = pairs.map(({ left, right }) => {
        const l = map.get(left.id)!; const r = map.get(right.id)!;
        const target = Math.random() < 0.5 ? l : r; const other = target.id === l.id ? r : l;
        return { entry: target, other, options: sample([target.w, other.w], 2) };
      });
      setRound(sample(qs, Math.min(ROUND_SIZE, qs.length)));
      setIndex(0); setScore(0); setSelected(null); setDone(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "词条加载失败，请重试。");
    } finally { setLoading(false); }
  };
  const choose = (word: string) => {
    if (selected || !current) return;
    setSelected(word); if (word === current.entry.w) setScore((value) => value + 1);
  };
  const next = () => { if (index + 1 >= round.length) setDone(true); else { setIndex((value) => value + 1); setSelected(null); } };
  const correct = selected === current?.entry.w;

  return (
    <div className="page practice-module-page">
      <BackLink />
      <header className="page-head"><p className="eyebrow">练习 · 易混词辨析</p><h1 className="display">分清相似的词。</h1><p className="lede">看中文释义，在容易混淆的词之间做出选择。</p></header>
      {loadError && <p className="module-error">{loadError}</p>}
      {!round.length || done ? (
        <section className="panel module-start">
          {done ? <><p className="eyebrow">本轮完成</p><h2 className="display">{score} / {round.length}</h2><p className="lede">答对 {score} 题。</p></> : <><p className="eyebrow">重点词组</p><h2 className="display">{pairs.length} 组</h2><p className="lede">从词条用法提示和常见易混词中整理，每轮随机练习 {Math.min(ROUND_SIZE, pairs.length)} 组。</p></>}
          <button className="btn btn-primary btn-xl" onClick={() => void begin()} disabled={loading || !pairs.length}>{loading ? "正在准备……" : done ? <><RotateCcw size={18} /> 再练一轮</> : "开始练习"}</button>
        </section>
      ) : current ? (
        <section className="panel module-question">
          <div className="module-progress"><span>第 {index + 1} / {round.length} 题</span><span>本轮 {score} 分</span></div>
          <p className="eyebrow">选择符合释义的单词</p><h2 className="display">{current.entry.senses.map((sense) => sense.zh).join("；")}</h2>
          <p className="module-phonetic">{current.entry.uk}</p>
          {current.entry.ex[0] && <p className="module-example" lang="en">{current.entry.ex[0].en}</p>}
          <div className="module-choices">{current.options.map((option) => <button key={option} className={`module-choice ${selected === option ? option === current.entry.w ? "is-correct" : "is-wrong" : selected && option === current.entry.w ? "is-answer" : ""}`} onClick={() => choose(option)} disabled={!!selected}>{option}</button>)}</div>
          {selected && <div className={`module-feedback ${correct ? "is-correct" : "is-wrong"}`}><b>{correct ? <><Check size={18} /> 正确</> : <><X size={18} /> 正确答案：{current.entry.w}</>}</b><p>{current.entry.tip || current.other.tip}</p><p><strong>{current.other.w}</strong>：{current.other.senses.map((sense) => sense.zh).join("；")}</p><button className="btn btn-primary" onClick={next}>{index + 1 === round.length ? "查看成绩" : "下一题"}<ArrowRight size={17} /></button></div>}
        </section>
      ) : null}
      {entries.size > 0 && <span className="sr-only">已加载 {entries.size} 个词条</span>}
    </div>
  );
}
