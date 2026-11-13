import json, os, re, collections
idx = json.load(open(os.path.expanduser('~/mnt/phemor/public/atlas/index.json')))
rows = idx['words']
by_word = {}
for r in rows:
    by_word.setdefault(r[1].lower(), r[0])
    by_word.setdefault(r[0].lower(), r[0])
def lemma_candidates(w):
    c = []
    for suf, rep in (("ies","y"),("ied","y"),("es",""),("s",""),("ed",""),("d",""),("ing",""),("ing","e"),("er",""),("est",""),("ly","")):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            c.append(w[:-len(suf)] + rep)
    if re.search(r"(.)\1(ed|ing|er|est)$", w):
        c.append(re.sub(r"(.)\1(ed|ing|er|est)$", r"\1", w))
    return c
lists = {"初中": "1 初中-乱序.txt", "高中": "2 高中-乱序.txt", "四级": "3 四级-乱序.txt", "六级": "4 六级-乱序.txt", "考研": "5 考研-乱序.txt"}
out = {}
for name, f in lists.items():
    words = []
    for line in open(f, encoding="utf-8"):
        line = line.strip()
        if line:
            words.append(line.split("\t")[0].strip())
    exact, lem, miss, phr = [], [], [], 0
    seen = set()
    for w in words:
        k = w.lower()
        if " " in k or "." in k: phr += 1
        if k in by_word: hit = by_word[k]; kind = exact
        else:
            hit = next((by_word[c] for c in lemma_candidates(k) if c in by_word), None); kind = lem
        if hit:
            if hit not in seen: seen.add(hit); kind.append((w, hit))
        else: miss.append(w)
    out[name] = {"total": len(words), "ids": sorted(seen), "exact": len(exact), "lemma": len(lem), "miss": miss}
    print(f"{name}: 词表 {len(words)} 个（含短语 {phr}）→ 词库命中 {len(seen)}（精确 {len(exact)} + 变形 {len(lem)}），缺口 {len(miss)}；命中率 {len(seen)/len(words):.0%}")
    print("   缺口样例:", miss[:25])
json.dump(out, open("coverage.json", "w"), ensure_ascii=False)
# cefr distribution of hits
cef = collections.Counter()
for name in out:
    c = collections.Counter(rows[[r[0] for r in rows].index(i)][4] for i in out[name]["ids"][:0]) 
