#!/usr/bin/env python3
"""生成端到端测试用的迷你站点（浏览器真实跑一遍：下载包、导入文件、断网、断网后播放发音）。

  ATLAS_BASE=/words/ ATLAS_MEDIA=0 VITE_PACK_SHARE_URL=https://pan.quark.cn/s/demo VITE_PACK_SHARE_CODE=1234 npm run build
  python3 scripts/pack/make_e2e_fixture.py /tmp/phemor-e2e
  python3 scripts/pack/e2e.py /tmp/phemor-e2e /tmp/phemor-shots     # 需要 pip install playwright 和 Chrome

迷你站点 = dist + 真实词条 + 12 个词的媒体包 + 一个含 2 个词的新增词包（其中 1 个是对现有词的勘误）。
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_packs as bp  # noqa: E402

ROOT = bp.ROOT
out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/phemor-e2e")
atlas = ROOT / "public" / "atlas"
if not (ROOT / "dist" / "index.html").exists():
    bp.die("先运行：ATLAS_BASE=/words/ npm run build")
if out.exists():
    shutil.rmtree(out)
site = out / "site" / "words"
site.mkdir(parents=True)
shutil.copytree(ROOT / "dist", site, dirs_exist_ok=True)
(site / "atlas").mkdir(exist_ok=True)
shutil.copy(atlas / "index.json", site / "atlas" / "index.json")
shutil.copytree(atlas / "entries", site / "atlas" / "entries", dirs_exist_ok=True)
shutil.copytree(ROOT / "public" / "brand", site / "brand", dirs_exist_ok=True)

idx = json.loads((atlas / "index.json").read_text(encoding="utf-8"))
ids = [r[0] for r in idx["words"][:12]]
files = [(f"atlas/{k}/{w}.webp", atlas / k / f"{w}.webp") for w in ids for k in ("img", "thumb")]
files += [(f"atlas/audio/{k}/{w}.mp3", atlas / "audio" / k / f"{w}.mp3") for w in ids for k in ("uk", "us", "ex")]
packs = out / "packs"
bp.write_pack(packs, {"id": "media-mini", "name": "测试媒体包", "version": 1, "kind": "media", "group": "测试", "order": 10,
                      "description": "12 个词", "words": 12}, files)

# 第 13 个词的媒体不放进包，用来测试「没装包时照常联网」
online_only = idx["words"][12][0]
for rel in (f"thumb/{online_only}.webp", f"img/{online_only}.webp", f"audio/uk/{online_only}.mp3"):
    (site / "atlas" / rel).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(atlas / rel, site / "atlas" / rel)

# 新增词包：zeitgeist 是新词（借用 library 的图和音），library 是勘误
src = Path(tempfile.mkdtemp())
for k in ("uk", "us", "ex"):
    (src / "audio" / k).mkdir(parents=True)
    shutil.copy(atlas / "audio" / k / "library.mp3", src / "audio" / k / "zeitgeist.mp3")
(src / "img").mkdir()
shutil.copy(atlas / "img" / "library.webp", src / "img" / "zeitgeist.webp")
(src / "words.json").write_text(json.dumps([
    {"w": "zeitgeist", "uk": "/ˈzaɪtɡaɪst/", "us": "/ˈzaɪtɡaɪst/", "cefr": "C1", "topic": "society",
     "senses": [{"pos": "n.", "zh": "时代精神", "en": "The mood of a particular period."}],
     "ex": [{"en": "The film captured the zeitgeist of the 1990s.", "zh": "这部电影捕捉了九十年代的时代精神。"}]},
    {"w": "library", "cefr": "A1", "topic": "education", "senses": [{"pos": "n.", "zh": "图书馆（更新版）", "en": "A place for books."}],
     "ex": [{"en": "I study in the library.", "zh": "我在图书馆学习。"}]},
], ensure_ascii=False), encoding="utf-8")

class A:  # noqa: D101
    pass
a = A()
a.src, a.id, a.name, a.version, a.desc, a.group, a.atlas, a.out = str(src), "new-demo", "示例新增词", 1, None, None, str(atlas), str(packs)
bp.cmd_words(a)
shutil.copytree(packs, site / "packs")
bp.write_catalog(site / "packs")
# 一个从未被打开过的词：断网后还能看到它，说明词条已被后台预载
far = next(r[0] for r in idx["words"][5000:] if r[0].isalpha())
(out / "fixture.json").write_text(json.dumps({"ids": ids, "online_only": online_only, "far_word": far}), encoding="utf-8")
shutil.rmtree(src, ignore_errors=True)
print(f"迷你站点：{out}")
