import assert from "node:assert/strict";
import test from "node:test";
import { allowedFile, checkManifest, sanitizeWords } from "./spec.ts";

test("only known media and text paths are allowed", () => {
  assert.equal(allowedFile("atlas/img/library.webp"), "image/webp");
  assert.equal(allowedFile("atlas/thumb/a-m.webp"), "image/webp");
  assert.equal(allowedFile("atlas/audio/uk/library.mp3"), "audio/mpeg");
  assert.equal(allowedFile("atlas/audio/ex2/library.mp3"), "audio/mpeg");
  assert.equal(allowedFile("atlas/entries/12.json"), "application/json; charset=utf-8");
  assert.equal(allowedFile("atlas/index.json"), "application/json; charset=utf-8");
  assert.equal(allowedFile("sfx/tap.mp3"), "audio/mpeg");
  assert.equal(allowedFile("brand/og-card.jpg"), "image/jpeg");
  for (const bad of ["sw.js", "index.html", "atlas/../sw.js", "/atlas/img/a.webp", "atlas/img/A.webp", "atlas/img/a.html", "atlas/audio/zz/a.mp3", "atlas\\img\\a.webp", "assets/index.js", "manifest.webmanifest", "atlas/img/" + "a".repeat(80) + ".webp"])
    assert.equal(allowedFile(bad), null, bad);
});

test("manifest checks", () => {
  const ok = checkManifest({ format: 1, id: "pic-a1", name: "A1 图片", version: 2, words: 10, files: 20, bytes: 1000 });
  assert.equal(ok.id, "pic-a1");
  assert.equal(ok.version, 2);
  assert.throws(() => checkManifest(null), /pack\.json/);
  assert.throws(() => checkManifest({ format: 3, id: "x", version: 1 }), /版本太新/);
  assert.throws(() => checkManifest({ format: 2, id: "x", version: 1 }), /加密单词包/);
  const enc = checkManifest({ format: 2, id: "list-senior", version: 1, crypt: { alg: "A256GCM", kv: 1 } });
  assert.deepEqual(enc.crypt, { alg: "A256GCM", kv: 1 });
  assert.equal(ok.crypt, undefined);
  assert.throws(() => checkManifest({ format: 1, id: "../x", version: 1 }), /编号/);
  assert.throws(() => checkManifest({ format: 1, id: "x", version: 0 }), /版本号/);
});

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  w: id,
  uk: "/a/",
  us: "/a/",
  senses: [{ pos: "n.", zh: "测试", en: "a test" }],
  ex: [{ en: "A test.", zh: "测试。" }],
  col: [],
  fam: [],
  syn: [],
  ant: [],
  tip: "",
  cefr: "B1",
  topic: "daily",
  m: 31,
  ...extra,
});

test("word data is sanitised: bad rows dropped, remote media stripped, text clamped", () => {
  const out = sanitizeWords(
    {
      rows: [
        ["good", "good", "adj. 好", "/g/", 2, 14, 31],
        ["noentry", "x", "x", "x", 0, 0, 0],
        ["bad level", "x", "x", "x", 9, 0, 0],
        ["badtopic", "x", "x", "x", 0, 99, 0],
        ["good", "dup", "x", "x", 0, 0, 0],
        "garbage",
      ],
      entries: [entry("good", { media: { img: "https://evil.example/x.png" }, tip: "t".repeat(5000) }), entry("badtopic"), { id: "bad id", w: "x", senses: [] }, entry("nosense", { senses: [] })],
    },
    19,
    6,
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0][0], "good");
  assert.equal(out.entries.length, 1);
  assert.equal("media" in out.entries[0], false);
  assert.equal(out.entries[0].tip.length, 400);
  assert.deepEqual(sanitizeWords("nope", 19, 6), { rows: [], entries: [] });
});
