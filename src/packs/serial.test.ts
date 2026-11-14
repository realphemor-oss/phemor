import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSerial, generateSerial, hashSerial, looksLikeSerial, normalizeSerial, SERIAL_ALPHABET } from "./serial";

test("生成的序列号格式正确且不重复", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const s = generateSerial();
    assert.match(s, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
    assert.equal(normalizeSerial(s), s.replace(/-/g, ""));
    seen.add(s);
  }
  assert.equal(seen.size, 2000);
});

test("字符均匀：每个字符都会出现", () => {
  const count = new Map<string, number>();
  for (let i = 0; i < 4000; i++) for (const ch of generateSerial().replace(/-/g, "")) count.set(ch, (count.get(ch) ?? 0) + 1);
  assert.equal(count.size, SERIAL_ALPHABET.length);
  const avg = (4000 * 16) / SERIAL_ALPHABET.length;
  for (const n of count.values()) assert.ok(n > avg * 0.9 && n < avg * 1.1, `分布偏了：${n} vs ${avg}`);
});

test("粘贴时的空格、小写、全角横线都能认", () => {
  const s = generateSerial();
  assert.equal(normalizeSerial(` ${s.toLowerCase()} `), s.replace(/-/g, ""));
  assert.equal(normalizeSerial(s.replace(/-/g, " ")), s.replace(/-/g, ""));
  assert.equal(normalizeSerial(s.replace(/-/g, "—")), s.replace(/-/g, ""));
  assert.equal(formatSerial(normalizeSerial(s)!), s);
});

test("格式不对的都拒绝", () => {
  for (const bad of ["", "ABCD", "ABCD-ABCD-ABCD-ABC", "ABCD-ABCD-ABCD-ABCDE", "0000-1111-OOOO-IIII", "PHEMOR1.abc"]) assert.equal(normalizeSerial(bad), null, bad);
});

test("looksLikeSerial 不把离线激活码当序列号", () => {
  assert.equal(looksLikeSerial(generateSerial()), true);
  assert.equal(looksLikeSerial("PHEMOR1.eyJ2IjoxfQ"), false);
  assert.equal(looksLikeSerial("hello"), false);
});

test("哈希稳定、不同序列号不同", async () => {
  const a = normalizeSerial(generateSerial())!;
  const b = normalizeSerial(generateSerial())!;
  assert.equal(await hashSerial(a), await hashSerial(a));
  assert.notEqual(await hashSerial(a), await hashSerial(b));
  assert.match(await hashSerial(a), /^[0-9a-f]{64}$/);
});
