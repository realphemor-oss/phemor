import type { Entry, IndexRow } from "../atlas/types";

/**
 * 单词包（.phemor）是一个 ZIP（不压缩，STORE），结构：
 *   pack.json                 清单
 *   words.json                可选：新增/更新的词条 { rows, entries }
 *   files/atlas/img/<id>.webp 媒体与文本文件，安装后按同样的网址放进本机缓存
 * 详见 docs/packs.md。
 *
 * 格式 1 = 明文；格式 2 = 加密（pack.json 里有 crypt，files/ 和 words.json 里每个文件都是 iv+AES-GCM 密文，
 * 需要激活码里对应的密钥才能安装，见 crypto.ts）。pack.json 永远是明文。
 */
export const PACK_FORMAT = 1;
export const PACK_FORMAT_ENCRYPTED = 2;
export const PACK_CACHE = "phemor-packs";
export const PACK_EXT = ".phemor";

export class PackError extends Error {}

export interface PackManifest {
  format: number;
  id: string;
  name: string;
  version: number;
  description: string;
  kind: string;
  words: number;
  files: number;
  bytes: number;
  created: string;
  /** 只有加密包才有：算法和密钥版本。 */
  crypt?: { alg: "A256GCM"; kv: number };
}

export interface Extras {
  rows: IndexRow[];
  entries: Entry[];
}

const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const WORD_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SLUG = "[a-z0-9][a-z0-9._-]{0,63}";

/** Only these paths may be written to the cache; anything else in a pack is rejected. */
const FILE_RULES: [RegExp, string][] = [
  [/^atlas\/index\.json$/, "application/json; charset=utf-8"],
  [/^atlas\/entries\/\d{1,5}\.json$/, "application/json; charset=utf-8"],
  [new RegExp(`^atlas/(img|thumb)/${SLUG}\\.webp$`), "image/webp"],
  [new RegExp(`^atlas/audio/(uk|us|ex|ex2)/${SLUG}\\.mp3$`), "audio/mpeg"],
  [/^sfx\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.mp3$/, "audio/mpeg"],
  [/^brand\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(webp|jpg)$/, "image/webp"],
];

/** MIME type for an allowed pack file, or null when the path is not allowed. */
export function allowedFile(path: string): string | null {
  if (path.length > 160 || path.includes("..") || path.includes("\\") || path.startsWith("/")) return null;
  for (const [re, type] of FILE_RULES) if (re.test(path)) return path.endsWith(".jpg") ? "image/jpeg" : type;
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const strList = (v: unknown, n: number, max = 120) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => x.slice(0, max)) : []);

export function checkManifest(v: unknown): PackManifest {
  if (!isObj(v)) throw new PackError("这不是有效的单词包（缺少 pack.json）。");
  if (v.format !== PACK_FORMAT && v.format !== PACK_FORMAT_ENCRYPTED) throw new PackError("这个单词包的版本太新，请先更新网页应用。");
  let crypt: PackManifest["crypt"];
  if (v.format === PACK_FORMAT_ENCRYPTED) {
    const c = v.crypt;
    if (!isObj(c) || c.alg !== "A256GCM" || !int(c.kv, 1, 1000)) throw new PackError("加密单词包的清单不完整。");
    crypt = { alg: "A256GCM", kv: c.kv as number };
  }
  if (typeof v.id !== "string" || !PACK_ID.test(v.id)) throw new PackError("单词包的编号不合法。");
  if (!int(v.version, 1, 1_000_000)) throw new PackError("单词包的版本号不合法。");
  return {
    format: v.format as number,
    id: v.id,
    name: str(v.name, 60) || v.id,
    version: v.version as number,
    description: str(v.description, 300),
    kind: str(v.kind, 20),
    words: int(v.words, 0, 1e6) ? (v.words as number) : 0,
    files: int(v.files, 0, 1e6) ? (v.files as number) : 0,
    bytes: int(v.bytes, 0, 1e10) ? (v.bytes as number) : 0,
    created: str(v.created, 40),
    ...(crypt ? { crypt } : {}),
  };
}

export const MAX_EXTRA_WORDS = 20000;

/** Clean the text part of a pack. Packs come from outside, so nothing is trusted. */
export function sanitizeWords(v: unknown, topics: number, levels: number): Extras {
  const out: Extras = { rows: [], entries: [] };
  if (!isObj(v)) return out;
  const entries = new Map<string, Entry>();
  if (Array.isArray(v.entries))
    for (const e of v.entries.slice(0, MAX_EXTRA_WORDS)) {
      if (!isObj(e) || typeof e.id !== "string" || !WORD_ID.test(e.id) || typeof e.w !== "string" || !e.w) continue;
      const senses = (Array.isArray(e.senses) ? e.senses : [])
        .filter(isObj)
        .slice(0, 3)
        .map((s) => ({ pos: str(s.pos, 12), zh: str(s.zh, 120), en: str(s.en, 300) }))
        .filter((s) => s.zh);
      if (!senses.length) continue;
      const ex = (Array.isArray(e.ex) ? e.ex : [])
        .filter(isObj)
        .slice(0, 2)
        .map((x) => ({ en: str(x.en, 400), zh: str(x.zh, 400) }))
        .filter((x) => x.en);
      entries.set(e.id, {
        id: e.id,
        w: e.w.slice(0, 80),
        uk: str(e.uk, 80),
        us: str(e.us, 80),
        senses,
        ex,
        col: strList(e.col, 4),
        fam: strList(e.fam, 4),
        syn: strList(e.syn, 3),
        ant: strList(e.ant, 2),
        tip: str(e.tip, 400),
        cefr: str(e.cefr, 3),
        topic: str(e.topic, 20),
        note: str(e.note, 300) || undefined,
        m: int(e.m, 0, 31) ? (e.m as number) : 0,
      });
    }
  const seen = new Set<string>();
  if (Array.isArray(v.rows))
    for (const r of v.rows.slice(0, MAX_EXTRA_WORDS)) {
      if (!Array.isArray(r) || r.length < 7) continue;
      const [id, word, zh, ipa, cefr, topic, media] = r;
      if (typeof id !== "string" || !entries.has(id) || seen.has(id) || typeof word !== "string") continue;
      if (!int(cefr, 0, levels - 1) || !int(topic, 0, topics - 1) || !int(media, 0, 31)) continue;
      seen.add(id);
      out.rows.push([id, word.slice(0, 80), str(zh, 200), str(ipa, 80), cefr as number, topic as number, media as number]);
    }
  out.entries = out.rows.map((r) => entries.get(r[0])!);
  return out;
}
