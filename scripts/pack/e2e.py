"""非莫离线单词包端到端测试：真实浏览器里下载包、导入文件、断网、断网后读取发音。
用法：python3 scripts/pack/e2e.py <make_e2e_fixture.py 生成的目录> <截图目录>
需要：pip install playwright；Chrome 路径放在环境变量 CHROME_PATH（不设就用 playwright 自带的 chromium）。
"""
import atexit, json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

SITE = sys.argv[1]
SHOTS = sys.argv[2]
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://localhost:8765/words/"
_srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", f"{SITE}/site"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
atexit.register(_srv.terminate)
time.sleep(1)
fx = json.load(open(f"{SITE}/fixture.json"))
errors, results = [], []

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": os.environ["CHROME_PATH"]} if os.environ.get("CHROME_PATH") else {}), args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.add_init_script("try{localStorage.setItem('word-atlas:settings', JSON.stringify({onboarded:true, splash:false, sfx:false, ambience:'off'}))}catch(e){}")
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())

    page.goto(BASE + "#/packs")
    page.wait_for_selector("h1.display", timeout=15000)
    page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=15000)
    check("service worker controls the page", True)
    page.wait_for_selector(".pack-row", timeout=10000)
    check("catalog lists 2 packs", page.locator(".packs-list .pack-row").count() == 2, str(page.locator(".packs-list .pack-row").count()))
    page.screenshot(path=f"{SHOTS}/1-packs-before.png", full_page=True)

    # Quark share card (the build sets VITE_PACK_SHARE_URL/CODE)
    page.wait_for_selector(".packs-share", timeout=5000)
    share = page.locator(".packs-share").inner_text()
    check("share card shows open-Quark button and code", "打开夸克网盘" in share and "提取码 1234" in share, share[:60].replace("\n", " "))

    # background preload of all entry text (the slim build ships no media, only text)
    t0, warmed = time.time(), False
    while time.time() - t0 < 60 and not warmed:
        warmed = page.evaluate("caches.match('/words/atlas/entries/72.json').then(r => !!r)")
        if not warmed:
            page.wait_for_timeout(500)
    check("entry text preloaded in background (last chunk cached)", warmed, f"{time.time() - t0:.1f}s")
    ncache = page.evaluate("caches.keys().then(async ks => { let n = 0; for (const k of ks) { if (k === 'phemor-packs') continue; n += (await (await caches.open(k)).keys()).filter(r => r.url.includes('/atlas/entries/')).length } return n })")
    check("all 73 entry chunks cached", ncache >= 73, str(ncache))

    # install media-mini from the online catalog (download + install path)
    row = page.locator(".pack-row", has_text="测试媒体包")
    row.get_by_role("button", name="下载").click()
    page.wait_for_selector("text=已添加「", timeout=20000)
    check("catalog download installs media pack", True)

    # install new-demo from a local file (file import path)
    page.wait_for_function("document.querySelector('.packs-busy') === null", timeout=10000)
    page.set_input_files("input[type=file]", f"{SITE}/packs/new-demo.phemor")
    page.wait_for_function("document.body.innerText.includes('已添加「示例新增词」')", timeout=20000)
    page.wait_for_function("document.querySelector('.packs-busy') === null", timeout=10000)
    check("file import installs words pack", True)

    n = page.evaluate("caches.open('phemor-packs').then(c => c.keys()).then(k => k.length)")
    check("pack files are in the packs cache", n == 65, f"{n} (expected 60+5)")
    page.screenshot(path=f"{SHOTS}/2-packs-after.png", full_page=True)

    # new word is visible without reloading the page
    page.goto(BASE + "#/")
    page.wait_for_selector(".page.today", timeout=10000)
    page.wait_for_function("document.body.innerText.includes('7,299')", timeout=10000)
    check("word total grew by one (7,299)", True)
    page.goto(BASE + "#/atlas?q=zeitgeist")
    page.wait_for_function("document.body.innerText.toLowerCase().includes('zeitgeist')", timeout=10000)
    check("search finds the pack word", True)
    page.goto(BASE + "#/w/zeitgeist")
    page.wait_for_function("document.body.innerText.includes('时代精神')", timeout=10000)
    check("entry sheet shows pack entry text", True)
    page.wait_for_timeout(500)
    page.screenshot(path=f"{SHOTS}/3-entry.png")
    corrected = page.evaluate("fetch('/words/atlas/entries/0.json').then(r=>r.json()).then(j=>j.length)")
    page.goto(BASE + "#/w/library")
    page.wait_for_function("document.body.innerText.includes('图书馆（更新版）')", timeout=10000)
    check("pack entry corrects an existing word", True)
    img_ok = page.evaluate("""() => new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = '/words/atlas/img/zeitgeist.webp'; })""")
    check("pack image decodes", img_ok > 0, str(img_ok))

    # warm one runtime-cached (non-pack) file while online
    online_only = fx["online_only"]
    st = page.evaluate(f"fetch('/words/atlas/thumb/{online_only}.webp').then(r=>r.status)")
    check("online-only thumb served by network", st == 200)

    # ---- offline ----
    ctx.set_offline(True)
    page.goto(BASE + "#/")
    page.reload()
    page.wait_for_selector(".page.today", timeout=15000)
    check("app shell opens offline", True)
    page.wait_for_function("document.body.innerText.includes('7,299')", timeout=10000)
    check("word list (index.json) available offline", True)

    for w in ("library", "zeitgeist", fx["ids"][3]):
        r = page.evaluate(f"""() => fetch('/words/atlas/audio/uk/{w}.mp3', {{headers: {{Range: 'bytes=0-1'}}}}).then(async r => [r.status, r.headers.get('content-range'), (await r.arrayBuffer()).byteLength]).catch(e => ['ERR', String(e)])""")
        check(f"offline Range request for {w} audio returns 206", r[0] == 206 and r[2] == 2, str(r))
    r = page.evaluate("""() => fetch('/words/atlas/audio/uk/library.mp3').then(async r => [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength])""")
    check("offline full audio fetch works", r[0] == 200 and r[1] == "audio/mpeg" and r[2] > 1000, str(r))
    r = page.evaluate("""() => fetch('/words/atlas/audio/uk/library.mp3', {headers: {Range: 'bytes=100-'}}).then(async r => [r.status, r.headers.get('content-range')])""")
    check("open-ended Range works", r[0] == 206, str(r))
    r = page.evaluate("""() => fetch('/words/atlas/audio/uk/library.mp3', {headers: {Range: 'bytes=99999999-'}}).then(r => r.status)""")
    check("out-of-range request gives 416", r == 416, str(r))
    img_ok = page.evaluate("""() => new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = '/words/atlas/thumb/%s.webp'; })""" % fx["ids"][5])
    check("offline pack thumb decodes", img_ok > 0, str(img_ok))
    img_ok = page.evaluate("""() => new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = '/words/atlas/thumb/%s.webp'; })""" % online_only)
    check("offline runtime-cached thumb decodes", img_ok > 0, str(img_ok))
    # real <audio> element playback metadata (Chrome issues Range requests)
    dur = page.evaluate("""() => new Promise(res => { const a = new Audio('/words/atlas/audio/us/library.mp3'); a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(-1); setTimeout(() => res(-2), 8000); })""")
    check("<audio> loads offline from pack", dur and dur > 0, str(dur))
    page.goto(BASE + "#/w/zeitgeist")
    page.wait_for_function("document.body.innerText.includes('时代精神')", timeout=10000)
    check("pack entry opens offline", True)
    page.screenshot(path=f"{SHOTS}/4-offline-entry.png")
    # a word whose entry chunk was never visited by the user: only the background preload can serve it
    page.goto(BASE + "#/w/" + fx["far_word"])
    page.wait_for_function("document.body.innerText.includes('Something that takes your attention away')", timeout=10000)
    check("far word's entry text opens offline (preloaded)", True)
    page.screenshot(path=f"{SHOTS}/4b-offline-far.png")

    # ---- back online, remove a pack ----
    ctx.set_offline(False)
    page.goto(BASE + "#/packs")
    page.wait_for_selector(".packs-list", timeout=10000)
    installed = page.locator(".packs-list", has=page.locator("text=已添加").first).last
    page.locator(".pack-row", has_text="示例新增词").get_by_role("button", name="移除").click()
    page.wait_for_function("!document.body.innerText.includes('v1 · 0 MB · 新增/更新')", timeout=10000)
    page.wait_for_timeout(600)
    n = page.evaluate("caches.open('phemor-packs').then(c => c.keys()).then(k => k.length)")
    check("removing a pack deletes its cached files", n == 60, str(n))
    page.goto(BASE + "#/")
    page.wait_for_function("document.body.innerText.includes('7,298')", timeout=10000)
    check("word total back to 7,298 after removal", True)

    # ---- install guide page ----
    page.goto(BASE + "#/install")
    page.wait_for_selector(".install-steps", timeout=10000)
    page.screenshot(path=f"{SHOTS}/5-install-android.png", full_page=True)
    page.get_by_role("tab", name="我在微信里").click()
    page.screenshot(path=f"{SHOTS}/6-install-wechat.png", full_page=True)
    b.close()

bad = [r for r in results if not r[1]]
real_errors = [e for e in errors if "Failed to load resource" not in e and "net::ERR_INTERNET_DISCONNECTED" not in e]
print("\nconsole errors:", real_errors[:10])
print(f"\n{len(results) - len(bad)}/{len(results)} passed")
sys.exit(1 if bad else 0)
