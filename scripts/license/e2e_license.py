#!/usr/bin/env python3
"""激活码功能端到端测试：真实浏览器 + 真实命令行工具，全程用临时密钥，不碰你的正式密钥。

  pip install playwright；Chrome 路径放在环境变量 CHROME_PATH（不设就用 playwright 自带的 chromium）。
  python3 scripts/license/e2e_license.py [工作目录，默认 /tmp/phemor-lic-e2e] [截图目录]

流程：init(临时密钥) → 用该公钥构建网页 → 做一个明文包（初中）和一个加密包（高中）→
  浏览器里依次验证：没有激活码被拒 / 明文包照常装 / 坏码和篡改码被拒 / 通用码能装 /
  绑定设备码只在那台设备上有效。
"""
import atexit, json, os, shutil, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "pack"))
import build_packs as bp  # noqa: E402

W = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/phemor-lic-e2e")
SHOTS = Path(sys.argv[2] if len(sys.argv) > 2 else W / "shots")
if W.exists():
    shutil.rmtree(W)
LIC = W / "keys"
SHOTS.mkdir(parents=True)
ENV = dict(os.environ, PHEMOR_LICENSE_DIR=str(LIC))


def sh(cmd, env=None, **kw):
    r = subprocess.run(cmd, cwd=ROOT, env=env or ENV, capture_output=True, text=True, **kw)
    if r.returncode:
        sys.exit(f"命令失败：{' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def cli(*a):
    return sh(["npx", "tsx", "scripts/license/cli.ts", *a])


def issue(customer, packs, device=None, days=None, show_name=True):
    a = ["issue", "--customer", customer, "--packs", packs] + (["--show-name"] if show_name else [])
    if device:
        a += ["--device", device]
    if days:
        a += ["--days", str(days)]
    out = cli(*a)
    return next(l.strip() for l in out.splitlines() if l.startswith("PHEMOR1."))


# ---------- 1. 临时密钥 + 构建 ----------
cli("init", "--no-source")
pub = (LIC / "issuer-public.jwk").read_text().strip()
benv = dict(ENV, ATLAS_BASE="/words/", ATLAS_MEDIA="0", VITE_ISSUER_PUBLIC_KEY=pub)
print("构建网页…", flush=True)
sh(["npm", "run", "build"], env=benv)

site = W / "site" / "words"
site.mkdir(parents=True)
shutil.copytree(ROOT / "dist", site, dirs_exist_ok=True)
atlas = ROOT / "public" / "atlas"
(site / "atlas").mkdir(exist_ok=True)
shutil.copy(atlas / "index.json", site / "atlas" / "index.json")
shutil.copytree(atlas / "entries", site / "atlas" / "entries", dirs_exist_ok=True)
shutil.copytree(ROOT / "public" / "brand", site / "brand", dirs_exist_ok=True)

# ---------- 2. 两个测试包 ----------
from PIL import Image  # noqa: E402

idx = json.loads((atlas / "index.json").read_text(encoding="utf-8"))
ids = [r[0] for r in idx["words"][:6]]
junior_ids, senior_ids = ids[:3], ids[3:]
media = W / "media"


def make_files(words):
    fs = []
    for i, w in enumerate(words):
        for k in ("img", "thumb"):
            p = media / k / f"{w}.webp"
            p.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (16 + i, 16), (200, 80 * i, 40)).save(p, "WEBP")
            fs.append((f"atlas/{k}/{w}.webp", p))
        p = media / "audio" / "uk" / f"{w}.mp3"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"ID3" + bytes(range(256)) * 8)
        fs.append((f"atlas/audio/uk/{w}.mp3", p))
    return fs


plain = W / "plain"
for pid, name, words in (("list-junior", "初中包", junior_ids), ("list-senior", "高中包", senior_ids)):
    bp.write_pack(plain, {"id": pid, "name": name, "version": 1, "kind": "media", "group": "测试", "order": 10,
                          "description": f"{len(words)} 个词", "words": len(words)}, make_files(words))
packs = W / "packs"
packs.mkdir()
shutil.copy(plain / "list-junior.phemor", packs / "list-junior.phemor")
cli("encrypt", str(plain / "list-senior.phemor"), "--out", str(packs))
print(sh(["npx", "tsx", "scripts/pack/verify.ts", str(packs / "list-junior.phemor"), str(packs / "list-senior.phemor")]))
enc_bytes = (packs / "list-senior.phemor").read_bytes()
plain_img = (media / "img" / f"{senior_ids[0]}.webp").read_bytes()

# ---------- 3. 激活码 ----------
def random_device():
    js = """const c=require('crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
const raw=Buffer.concat([Buffer.from([4]),Buffer.from(k.x,'base64url'),Buffer.from(k.y,'base64url')]);
process.stdout.write('PHD1.'+raw.toString('base64url'))"""
    return subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout


code_all = issue("测试甲", "高中")
code_tampered = code_all[:40] + ("A" if code_all[40] != "A" else "B") + code_all[41:]
code_other_dev = issue("测试乙", "高中", device=random_device())
code_junior_only = None  # 初中包免费，CLI 会拒绝

# ---------- 4. 浏览器 ----------
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "http://localhost:8766/words/"
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8766", "--directory", str(W / "site")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
atexit.register(srv.terminate)
time.sleep(1)
results, errors = [], []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def new_page(b, label):
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, permissions=["clipboard-read", "clipboard-write"])
    ctx.add_init_script("try{localStorage.setItem('word-atlas:settings', JSON.stringify({onboarded:true, splash:false, sfx:false}))}catch(e){}")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"[{label}] PAGEERROR {e}"))
    page.on("dialog", lambda d: d.accept())
    page.goto(BASE + "#/packs")
    page.wait_for_selector("h1.display", timeout=20000)
    page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=20000)
    return ctx, page


def idle(page):
    page.wait_for_function("document.querySelector('.packs-busy') === null", timeout=30000)


def body(page):
    return page.evaluate("document.body.innerText")


def import_pack(page, path, expect):
    """导入一个文件，等到页面出现 expect 里的任一文字，返回出现的那段。"""
    t0 = time.time()
    while time.time() - t0 < 15 and any(e in body(page) for e in expect):  # 等上一条提示消失，免得误判
        page.wait_for_timeout(300)
    page.set_input_files("input[type=file]", str(path))
    t0 = time.time()
    while time.time() - t0 < 30:
        txt = body(page)
        for e in expect:
            if e in txt:
                idle(page)
                return e
        page.wait_for_timeout(250)
    return None


def activate(page, code):
    page.fill(".license-paste input", code)
    page.get_by_role("button", name="激活").click()
    page.wait_for_timeout(600)
    return body(page)


def ncache(page):
    """数据库里的单词包文件数（单词包的图片和发音存在 IndexedDB 的 files 里）。"""
    return page.evaluate("""() => new Promise(res => {
        const r = indexedDB.open('phemor-packs');
        r.onerror = () => res(0);
        r.onsuccess = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('files')) { db.close(); return res(0); }
            const q = db.transaction('files').objectStore('files').count();
            q.onsuccess = () => { db.close(); res(q.result); };
            q.onerror = () => { db.close(); res(0); };
        };
    })""")


def stored_ok(page, wid):
    """通过离线服务（它从数据库里取）读这张图，返回开头 4 个字节。"""
    return page.evaluate("""(w) => fetch('/words/atlas/img/' + w + '.webp').then(async r => {
        if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); return Array.from(b.slice(0, 4)).map(x => String.fromCharCode(x)).join('') })""", wid)


def img_width(page, wid):
    return page.evaluate("""(w) => new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = '/words/atlas/img/' + w + '.webp'; })""", wid)


with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": os.environ["CHROME_PATH"]} if os.environ.get("CHROME_PATH") else {}), args=["--no-sandbox"])

    # ===== 设备 A =====
    ctx, page = new_page(b, "A")
    check("授权面板显示（构建时带了公钥）", page.locator(".license-panel").count() == 1)
    fp = page.locator(".license-device code").inner_text()
    check("面板显示设备指纹 XXXX-XXXX", __import__("re").fullmatch(r"[0-9A-F]{4}-[0-9A-F]{4}", fp) is not None, fp)
    page.screenshot(path=str(SHOTS / "1-license-panel.png"), full_page=True)

    got = import_pack(page, packs / "list-senior.phemor", ["请在下方「授权」", "已添加「"])
    check("没有激活码：加密包被拒绝并提示", got == "请在下方「授权」", str(got))
    check("被拒绝时没有任何文件写入", ncache(page) == 0, str(ncache(page)))

    got = import_pack(page, packs / "list-junior.phemor", ["已添加「", "请在下方「授权」"])
    check("初中包（明文基础包）不需要激活码", got == "已添加「", str(got))
    check("初中包 9 个文件进了数据库", ncache(page) == 9, str(ncache(page)))

    txt = activate(page, "PHEMOR1.abc")
    check("残缺的激活码被拒绝", page.locator(".license-list li").count() == 0 and "激活码" in txt)
    txt = activate(page, code_tampered)
    check("被篡改的激活码被拒绝", page.locator(".license-list li").count() == 0 and "已激活" not in txt)
    txt = activate(page, code_other_dev)
    check("别人设备的绑定码在这台设备上被拒绝", page.locator(".license-list li").count() == 0 and "已激活" not in txt, [l for l in txt.splitlines() if "设备" in l][:1].__repr__())

    txt = activate(page, code_all)
    check("通用激活码激活成功", page.locator(".license-list li").count() == 1 and "测试甲" in page.locator(".license-list").inner_text())
    page.screenshot(path=str(SHOTS / "2-activated.png"), full_page=True)

    got = import_pack(page, packs / "list-senior.phemor", ["已添加「", "请在下方「授权」"])
    check("激活后加密的高中包安装成功", got == "已添加「", str(got))
    check("高中包又加 9 个文件，共 18", ncache(page) == 18, str(ncache(page)))
    check("数据库里存的是解密后的图片（RIFF），不是密文", stored_ok(page, senior_ids[0]) == "RIFF", str(stored_ok(page, senior_ids[0])))
    check("新装的单词包不再写 Cache Storage（避免苹果上 16 秒冷启动）", page.evaluate("caches.has('phemor-packs')") is False)
    check("App 告诉离线服务：没有旧格式的包了", page.evaluate("""() => new Promise(res => { const r = indexedDB.open('phemor-packs'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('legacy'); q.onsuccess = () => { r.result.close(); res(q.result && q.result.value); }; }; })""") is False)
    check("解密后的图片能正常显示", img_width(page, senior_ids[0]) > 0, str(img_width(page, senior_ids[0])))
    check("激活码在刷新后仍然保留", (page.reload(), page.wait_for_selector(".license-list li", timeout=10000))[1] is not None)
    page.get_by_role("button", name="移除这个激活码").click()
    page.wait_for_timeout(400)
    check("可以移除激活码", page.locator(".license-list li").count() == 0)
    ctx.close()

    # ===== 设备 B：绑定设备的码 =====
    ctx, page = new_page(b, "B")
    page.get_by_role("button", name="复制设备码").click()
    page.wait_for_timeout(400)
    dev_code = page.evaluate("navigator.clipboard.readText()")
    check("复制设备码得到 PHD1. 开头的码", dev_code.startswith("PHD1."), dev_code[:12])
    code_bound = issue("测试丙", "高中,旅游", device=dev_code, days=30, show_name=False)
    txt = activate(page, code_bound)
    lt = page.locator(".license-list").inner_text()
    check("不带名字的绑定码：显示「已激活」「仅限本机」，不泄露客户名", "已激活" in lt and "仅限本机" in lt and "测试丙" not in lt, lt.replace("\n", " ")[:60])
    got = import_pack(page, packs / "list-senior.phemor", ["已添加「", "请在下方「授权」"])
    check("绑定码安装加密包成功", got == "已添加「", str(got))
    check("绑定设备装出的图片同样正确", stored_ok(page, senior_ids[0]) == "RIFF")
    ctx.close()

    # ===== 设备 C：拿到同一个绑定码却不是那台设备 =====
    ctx, page = new_page(b, "C")
    txt = activate(page, code_bound)
    check("绑定码拷到另一台设备上无法激活", page.locator(".license-list li").count() == 0 and "已激活" not in txt)
    got = import_pack(page, packs / "list-senior.phemor", ["已添加「", "请在下方「授权」"])
    check("另一台设备也装不了加密包", got == "请在下方「授权」", str(got))
    check("另一台设备仍为空", ncache(page) == 0)
    ctx.close()

    # ===== 设备 D：联网序列号激活（用假的 /api/activate 应答，真实的服务端逻辑有 worker 的单元测试） =====
    ctx, page = new_page(b, "D")
    page.get_by_role("button", name="复制设备码").click()
    page.wait_for_timeout(400)
    dev_d = page.evaluate("navigator.clipboard.readText()")
    code_d = issue("序列号客户", "高中", device=dev_d, days=None, show_name=False)
    seen = {}

    def fake_api(route):
        req = route.request
        seen["body"] = req.post_data_json
        if seen.get("mode") == "full":
            route.fulfill(status=409, content_type="application/json", body=json.dumps({"ok": False, "error": "limit", "message": "这个序列号已在 6 台设备上激活，名额已满。需要换设备请联系老师。", "max": 6}))
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "code": code_d, "packs": ["list-senior"], "used": 2, "max": 6, "remaining": 4}))

    page.route("**/api/activate", fake_api)
    page.fill(".license-paste input", "abcd efgh-jkmn pqrs")
    page.get_by_role("button", name="激活").click()
    page.wait_for_function("document.body.innerText.includes('已用 2/6')", timeout=15000)
    check("序列号激活成功并提示用了几台", "已用 2/6" in body(page))
    check("发给服务器的是规范化的序列号和本机设备码", seen["body"]["serial"].replace("-", "") == "ABCDEFGHJKMNPQRS" and seen["body"]["device"] == dev_d, str(seen["body"])[:80])
    check("序列号激活后授权列表出现一条", page.locator(".license-list li").count() == 1)
    got = import_pack(page, packs / "list-senior.phemor", ["已添加「", "请在下方「授权」"])
    check("用序列号换来的激活码能装加密包", got == "已添加「", str(got))
    check("序列号换来的包图片正确", stored_ok(page, senior_ids[0]) == "RIFF")
    page.locator(".license-list button").first.click()
    page.wait_for_timeout(300)
    seen["mode"] = "full"
    page.fill(".license-paste input", "WXYZ-2345-6789-ABCD")
    page.get_by_role("button", name="激活").click()
    page.wait_for_function("document.body.innerText.includes('名额已满')", timeout=15000)
    check("名额已满时把服务器的提示原样显示", "名额已满" in body(page) and page.locator(".license-list li").count() == 0)
    ctx.close()

    b.close()

check("没有页面脚本错误", not errors, "; ".join(errors)[:200])
bad = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(bad)}/{len(results)} 通过")
sys.exit(1 if bad else 0)
