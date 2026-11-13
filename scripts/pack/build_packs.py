#!/usr/bin/env python3
"""非莫单词包生成器（只用 Python 标准库；缩放图片需要 cwebp 或 Pillow）。

子命令：

  kits     生成默认套装：初中包 / 高中包 / 大学包（上、下），每个一个文件（推荐发给客户）
  kit      自定义套装：按难度、话题或词表（--ids-file）挑词
  base     把现有词库（public/atlas）拆成可下载的单词包：基础包 + 每个难度的「插画」「发音」包
  words    把一批新单词（词条 JSON + 插画 + 发音）打成一个单词包，发给客户即可
  catalog  扫描输出目录，生成在线目录 packs.json

用法见 docs/packs.md。包格式：ZIP（不压缩）= pack.json + words.json(可选) + files/<站内路径>
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"]
LEVEL_NAME = ["A1 入门", "A2 基础", "B1 进阶", "B2 中高", "C1 高级", "C2 精通"]
TOPICS = ["education", "work", "technology", "science", "environment", "health", "society", "government",
          "economy", "media", "arts", "travel", "city", "nature", "daily", "emotion", "thinking", "sport", "history"]
MEDIA = {"img": 1, "uk": 2, "us": 4, "ex": 8, "ex2": 16}
WORD_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
FIXED_TIME = (2026, 1, 1, 0, 0, 0)  # 固定时间戳：同样的内容每次打出同样的字节，sha256 稳定
EXT = ".phemor"


def die(msg):
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(1)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_pack(out_dir, manifest, files, words=None):
    """files: [(站内路径, 本地文件)]。返回写好的 .phemor 路径。"""
    if len(files) > 60000:
        die(f"{manifest['id']} 文件数 {len(files)} 超过 60000，请拆小。")
    total = sum(p.stat().st_size for _, p in files)
    if total >= 3.5e9:
        die(f"{manifest['id']} 超过 3.5GB，请拆小。")
    manifest = dict(manifest, format=1, files=len(files), bytes=total,
                    created=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{manifest['id']}{EXT}"
    tmp = dest.with_suffix(".tmp")

    def info(name):
        zi = zipfile.ZipInfo(name, FIXED_TIME)
        zi.compress_type = zipfile.ZIP_STORED
        zi.external_attr = 0o644 << 16
        return zi

    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=False) as zf:
        zf.writestr(info("pack.json"), json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
        if words:
            zf.writestr(info("words.json"), json.dumps(words, ensure_ascii=False, separators=(",", ":")))
        for rel, src in sorted(files):
            with open(src, "rb") as s, zf.open(info("files/" + rel), "w") as d:
                shutil.copyfileobj(s, d, 1 << 20)
    tmp.replace(dest)
    print(f"  {dest.name}  {dest.stat().st_size / 1e6:.1f} MB  {len(files)} 个文件")
    return dest


def write_catalog(out_dir):
    items = []
    for p in sorted(out_dir.glob(f"*{EXT}")):
        try:
            with zipfile.ZipFile(p) as zf:
                m = json.loads(zf.read("pack.json"))
        except Exception as e:  # noqa: BLE001
            print(f"  跳过 {p.name}：{e}")
            continue
        items.append({
            "id": m["id"], "name": m.get("name", m["id"]), "version": m["version"], "kind": m.get("kind", ""),
            "group": m.get("group", ""), "order": m.get("order", 999), "description": m.get("description", ""),
            "words": m.get("words", 0), "bytes": p.stat().st_size, "file": p.name, "sha256": sha256(p),
        })
    items.sort(key=lambda x: (x["order"], x["id"]))
    for x in items:
        x.pop("order")
    (out_dir / "packs.json").write_text(json.dumps({"format": 1, "packs": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"目录 {out_dir / 'packs.json'}：{len(items)} 个单词包")


# ---------------------------------------------------------------- base

def cmd_base(a):
    atlas = Path(a.atlas)
    idx = json.loads((atlas / "index.json").read_text(encoding="utf-8"))
    out = Path(a.out)
    limit = int(a.max_mb * 1e6)
    only = {x.upper() for x in a.only} if a.only else None
    built = 0

    if not only or "CORE" in only:
        files = [("atlas/index.json", atlas / "index.json")]
        files += [(f"atlas/entries/{p.name}", p) for p in sorted((atlas / "entries").glob("*.json"))]
        for sub, patterns in (("sfx", ("*.mp3",)), ("brand", ("*.webp", "*.jpg"))):
            d = ROOT / "public" / sub
            files += [(f"{sub}/{p.name}", p) for pat in patterns for p in sorted(d.glob(pat))]
        write_pack(out, {"id": "core", "name": "基础包（词条、音效、封面）", "version": a.version, "kind": "core", "group": "基础", "order": 0,
                         "description": "可选：词条文字、音效、封面（网页已会自动保存词条，通常不用装）", "words": len(idx["words"])}, files)
        built += 1

    for lv in range(len(CEFR)):
        if only and CEFR[lv] not in only:
            continue
        rows = [r for r in idx["words"] if r[4] == lv]
        for kind, label, parts in (("pic", "插画", ["img", "thumb"]), ("voice", "发音", ["uk", "us", "ex", "ex2"])):
            groups = []  # 每个词的文件放一起，拆包时不把一个词劈开
            for r in rows:
                wid, flags = r[0], r[6]
                g = []
                for part in parts:
                    bit = MEDIA["img"] if part in ("img", "thumb") else MEDIA[part]
                    if not flags & bit:
                        continue
                    if part in ("img", "thumb"):
                        rel = f"atlas/{part}/{wid}.webp"
                    else:
                        rel = f"atlas/audio/{part}/{wid}.mp3"
                    src = atlas / rel[len("atlas/"):]
                    if src.exists():
                        g.append((rel, src))
                if g:
                    groups.append((wid, g))
            chunks, cur, size = [], [], 0
            for wid, g in groups:
                gs = sum(p.stat().st_size for _, p in g)
                if cur and size + gs > limit:
                    chunks.append(cur)
                    cur, size = [], 0
                cur.append((wid, g))
                size += gs
            if cur:
                chunks.append(cur)
            for n, chunk in enumerate(chunks, 1):
                pid = f"{kind}-{CEFR[lv].lower()}" + (f"-{n}" if len(chunks) > 1 else "")
                part = f"（{n}/{len(chunks)}）" if len(chunks) > 1 else ""
                files = [f for _, g in chunk for f in g]
                write_pack(out, {"id": pid, "name": f"{LEVEL_NAME[lv]} · {label}{part}", "version": a.version, "kind": "media",
                                 "group": LEVEL_NAME[lv], "order": 10 + lv * 10 + (0 if kind == "pic" else 5),
                                 "description": f"{len(chunk)} 个词的{label}", "words": len(chunk)}, files)
                built += 1
    write_catalog(out)
    print(f"完成：{built} 个单词包 → {out}")


# ---------------------------------------------------------------- words

def slugify(word):
    s = re.sub(r"[^a-z0-9]+", "-", word.strip().lower().replace("’", "'")).strip("-")
    return s or "x"


def clean_entry(e):
    senses = [{"pos": (s.get("pos") or "").strip(), "zh": (s.get("zh") or "").strip(), "en": (s.get("en") or "").strip()}
              for s in (e.get("senses") or []) if s.get("zh")][:3]
    ex = [{"en": (x.get("en") or "").strip(), "zh": (x.get("zh") or "").strip()} for x in (e.get("ex") or []) if x.get("en")][:2]
    split = lambda xs: [x.strip() for x in (xs or []) if isinstance(x, str) and x.strip()]  # noqa: E731
    return {
        "w": (e.get("w") or "").strip(), "uk": (e.get("uk") or "").strip(), "us": (e.get("us") or "").strip(),
        "senses": senses, "ex": ex, "col": split(e.get("col"))[:4], "fam": split(e.get("fam"))[:4],
        "syn": split(e.get("syn"))[:3], "ant": split(e.get("ant"))[:2], "tip": (e.get("tip") or "").strip(),
        "cefr": e.get("cefr"), "topic": e.get("topic"), "note": (e.get("note") or "").strip(),
    }


def make_webp(src, dst, size, quality):
    """缩放成 size×size 的 webp：优先 cwebp，其次 Pillow，都没有就原样复制（并提示）。"""
    if shutil.which("cwebp"):
        subprocess.run(["cwebp", "-quiet", "-q", str(quality), "-m", "6", "-resize", str(size), str(size), str(src), "-o", str(dst)], check=True)
        return True
    try:
        from PIL import Image  # type: ignore
        with Image.open(src) as im:
            im.convert("RGB").resize((size, size), Image.LANCZOS).save(dst, "WEBP", quality=quality, method=6)
        return True
    except ImportError:
        pass
    if src.suffix.lower() == ".webp":
        shutil.copyfile(src, dst)
        return False
    die("缩放图片需要 cwebp（brew install webp）或 Pillow（pip3 install pillow）。")


def cmd_words(a):
    src = Path(a.src)
    if not (src / "words.json").exists():
        die(f"{src}/words.json 不存在。")
    raw = json.loads((src / "words.json").read_text(encoding="utf-8"))
    base_flags = {}  # 现有词的媒体标记：勘误时没带媒体的词，保留它原有的图片和发音
    if a.atlas and (Path(a.atlas) / "index.json").exists():
        base_flags = {r[0]: r[6] for r in json.loads((Path(a.atlas) / "index.json").read_text(encoding="utf-8"))["words"]}
    work = ROOT / ".pack-work" / a.id
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    entries, rows, files, seen, problems, resized_ok = [], [], [], set(), [], True
    for i, e in enumerate(raw, 1):
        c = clean_entry(e)
        wid = (e.get("id") or slugify(c["w"])).strip().lower()
        label = f"第 {i} 条（{c['w'] or '?'}）"
        if not c["w"]:
            problems.append(f"{label} 缺少 w")
            continue
        if not WORD_ID.match(wid):
            problems.append(f"{label} 的 id「{wid}」不合法（只能小写字母、数字、- . _）")
            continue
        if wid in seen:
            problems.append(f"{label} id 重复：{wid}")
            continue
        if c["cefr"] not in CEFR:
            problems.append(f"{label} cefr 必须是 {CEFR} 之一")
            continue
        if c["topic"] not in TOPICS:
            problems.append(f"{label} topic 必须是 {TOPICS} 之一")
            continue
        if not c["senses"] or not c["ex"]:
            problems.append(f"{label} 至少要有 1 个释义（senses）和 1 个例句（ex）")
            continue
        seen.add(wid)
        m = 0
        im = next((src / "img" / f"{wid}{ext}" for ext in (".webp", ".png", ".jpg", ".jpeg") if (src / "img" / f"{wid}{ext}").exists()), None)
        if im:
            (work / "img").mkdir(exist_ok=True)
            (work / "thumb").mkdir(exist_ok=True)
            resized_ok &= make_webp(im, work / "img" / f"{wid}.webp", 512, 74)
            resized_ok &= make_webp(im, work / "thumb" / f"{wid}.webp", 256, 70)
            files += [(f"atlas/img/{wid}.webp", work / "img" / f"{wid}.webp"), (f"atlas/thumb/{wid}.webp", work / "thumb" / f"{wid}.webp")]
            m |= MEDIA["img"]
        for kind in ("uk", "us", "ex", "ex2"):
            ap = src / "audio" / kind / f"{wid}.mp3"
            if ap.exists():
                files.append((f"atlas/audio/{kind}/{wid}.mp3", ap))
                m |= MEDIA[kind]
        m |= base_flags.get(wid, 0)
        c["id"], c["m"] = wid, m
        if not c["note"]:
            del c["note"]
        s0 = c["senses"][0]
        rows.append([wid, c["w"], f'{s0["pos"]} {s0["zh"]}'.strip(), c["uk"] or c["us"], CEFR.index(c["cefr"]), TOPICS.index(c["topic"]), m])
        entries.append(c)
        if wid in base_flags:
            print(f"  提示：{wid} 已在现有词库中，客户安装后会用这一条替换它（用于勘误）。")
    if problems:
        print("以下词条有问题，请修正后重试：", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        sys.exit(1)
    if not resized_ok:
        print("  提示：没有 cwebp/Pillow，图片按原样使用（缩略图和大图相同），体积会偏大。")
    out = Path(a.out)
    write_pack(out, {"id": a.id, "name": a.name, "version": a.version, "kind": "words", "group": a.group or "新增单词",
                     "order": 500, "description": a.desc or f"新增/更新 {len(rows)} 个词", "words": len(rows)},
               files, {"rows": rows, "entries": entries})
    shutil.rmtree(work, ignore_errors=True)
    write_catalog(out)
    print(f"完成：{len(rows)} 个词。把 {out / (a.id + EXT)} 发给客户即可。")


# ---------------------------------------------------------------- kits

PARTS = ("img", "thumb", "uk", "us", "ex", "ex2")
# 默认套装：按学习阶段。难度对应是近似的（CEFR → 学段），要按课标词表请用 kit --ids-file。
PRESETS = [
    ("kit-junior", "初中包", [0, 1], "A1–A2 最常用的基础词"),
    ("kit-senior", "高中包", [2], "B1 进阶词"),
    ("kit-college-1", "大学包（上）", [3], "B2 中高级词"),
    ("kit-college-2", "大学包（下）", [4, 5], "C1–C2 高级词"),
]


def word_files(atlas, wid, flags, parts):
    out = []
    for part in parts:
        bit = MEDIA["img"] if part in ("img", "thumb") else MEDIA[part]
        if not flags & bit:
            continue
        rel = f"atlas/{part}/{wid}.webp" if part in ("img", "thumb") else f"atlas/audio/{part}/{wid}.mp3"
        src = atlas / rel[len("atlas/"):]
        if src.exists():
            out.append((rel, src))
    return out


def build_kit(atlas, out, idx, pid, name, rows, version, desc, group, order, parts=PARTS):
    files = [f for r in rows for f in word_files(atlas, r[0], r[6], parts)]
    if not files:
        die(f"{pid}：没有选中任何带媒体的词。")
    return write_pack(out, {"id": pid, "name": name, "version": version, "kind": "media", "group": group, "order": order,
                            "description": desc or f"{len(rows)} 个词的插画和发音", "words": len(rows)}, files)


def cmd_kits(a):
    atlas = Path(a.atlas)
    idx = json.loads((atlas / "index.json").read_text(encoding="utf-8"))
    out = Path(a.out)
    for n, (pid, name, levels, desc) in enumerate(PRESETS, 1):
        rows = [r for r in idx["words"] if r[4] in levels]
        build_kit(atlas, out, idx, pid, name, rows, a.version, f"{len(rows):,} 个词 · {desc}", "按学习阶段", n)
    write_catalog(out)


def cmd_kit(a):
    atlas = Path(a.atlas)
    idx = json.loads((atlas / "index.json").read_text(encoding="utf-8"))
    names = [t[0] for t in idx["topics"]]
    rows = idx["words"]
    if a.levels:
        want = {CEFR.index(x.upper()) if x.upper() in CEFR else int(x) for x in a.levels}
        rows = [r for r in rows if r[4] in want]
    if a.topics:
        bad = [t for t in a.topics if t not in names]
        if bad:
            die(f"未知话题 {bad}，可用：{names}")
        want_t = {names.index(t) for t in a.topics}
        rows = [r for r in rows if r[5] in want_t]
    if a.ids_file:
        wanted = [ln.split("#")[0].strip().lower() for ln in Path(a.ids_file).read_text(encoding="utf-8").splitlines()]
        wanted = [w for w in wanted if w]
        by = {}
        for r in idx["words"]:
            by.setdefault(r[0], r)
            by.setdefault(r[1].lower(), r)
        picked, missing = {}, []
        for w in wanted:
            (picked.__setitem__(by[w][0], by[w]) if w in by else missing.append(w))
        if missing:
            print(f"  提示：词表里有 {len(missing)} 个词不在词库中，已跳过：{', '.join(missing[:15])}{' …' if len(missing) > 15 else ''}")
        keep = {r[0] for r in rows} if (a.levels or a.topics) else None
        rows = [r for r in picked.values() if keep is None or r[0] in keep]
    parts = tuple(a.parts) if a.parts else PARTS
    build_kit(atlas, Path(a.out), idx, a.id, a.name, rows, a.version, a.desc or f"{len(rows):,} 个词", a.group or "套装", a.order, parts)
    write_catalog(Path(a.out))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("base", help="把现有词库拆成单词包")
    b.add_argument("--atlas", default=str(ROOT / "public" / "atlas"))
    b.add_argument("--out", default=str(ROOT / "packs"))
    b.add_argument("--max-mb", type=float, default=120, help="单个包的体积上限，超过会拆成 -1 -2…（默认 120）")
    b.add_argument("--version", type=int, default=1, help="版本号；内容变了就加 1，客户那边会提示更新")
    b.add_argument("--only", nargs="*", help="只生成部分，例如 --only core A1 B2")
    b.set_defaults(fn=cmd_base)
    w = sub.add_parser("words", help="把一批新单词打成一个包")
    w.add_argument("src", help="含 words.json、img/、audio/uk|us|ex|ex2/ 的文件夹")
    w.add_argument("--id", required=True, help="包编号，小写字母数字和 -，例如 new-2027-01")
    w.add_argument("--name", required=True, help="客户看到的名字，例如「2027 年 1 月新增词」")
    w.add_argument("--version", type=int, default=1)
    w.add_argument("--desc")
    w.add_argument("--group")
    w.add_argument("--atlas", default=str(ROOT / "public" / "atlas"), help="用来检查 id 是否和现有词重复")
    w.add_argument("--out", default=str(ROOT / "packs"))
    w.set_defaults(fn=cmd_words)
    k = sub.add_parser("kits", help="生成默认套装：初中包 / 高中包 / 大学包（上、下），每个一个文件")
    k.add_argument("--atlas", default=str(ROOT / "public" / "atlas"))
    k.add_argument("--out", default=str(ROOT / "packs"))
    k.add_argument("--version", type=int, default=1)
    k.set_defaults(fn=cmd_kits)
    k = sub.add_parser("kit", help="自定义套装：按难度、话题或词表挑词")
    k.add_argument("--id", required=True)
    k.add_argument("--name", required=True)
    k.add_argument("--levels", nargs="*", help="难度，例如 A1 A2 或 0 1")
    k.add_argument("--topics", nargs="*", help="话题，例如 travel city")
    k.add_argument("--ids-file", help="词表文件：每行一个词（或词条 id），# 后面是注释")
    k.add_argument("--parts", nargs="*", choices=list(PARTS), help="只带部分媒体，例如 --parts thumb uk us（更小）")
    k.add_argument("--desc")
    k.add_argument("--group")
    k.add_argument("--order", type=int, default=50)
    k.add_argument("--version", type=int, default=1)
    k.add_argument("--atlas", default=str(ROOT / "public" / "atlas"))
    k.add_argument("--out", default=str(ROOT / "packs"))
    k.set_defaults(fn=cmd_kit)
    c = sub.add_parser("catalog", help="重新生成 packs.json")
    c.add_argument("--out", default=str(ROOT / "packs"))
    c.set_defaults(fn=lambda a: write_catalog(Path(a.out)))
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
