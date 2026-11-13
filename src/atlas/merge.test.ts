import assert from "node:assert/strict";
import test from "node:test";
import type { Entry, IndexRow } from "./types.ts";
import { mergeWords } from "./merge.ts";

const row = (id: string, cefr: number, zh = id): IndexRow => [id, id, zh, "", cefr, 0, 31];
const entry = (id: string): Entry => ({ id, w: id, uk: "", us: "", senses: [{ pos: "n.", zh: id, en: "" }], ex: [], col: [], fam: [], syn: [], ant: [], tip: "", cefr: "A1", topic: "daily", m: 31 });

const base = [row("a1", 0), row("a2", 0), row("b1", 2), row("b2", 2), row("c1", 4)];

test("new words join the path after the last word of the same or easier level", () => {
  const m = mergeWords(base, { rows: [row("n-b", 2), row("n-a", 0), row("n-c2", 5)], entries: ["n-b", "n-a", "n-c2"].map(entry) });
  assert.deepEqual(
    m.rows.map((r) => r[0]),
    ["a1", "a2", "n-a", "b1", "b2", "n-b", "c1", "n-c2"],
  );
  assert.equal(m.added, 3);
});

test("base positions stay addressable for chunked entries", () => {
  const m = mergeWords(base, { rows: [row("n-a", 0)], entries: [entry("n-a")] });
  assert.equal(m.baseIndex.get("b2"), 3);
  assert.equal(m.baseIndex.has("n-a"), false);
  assert.equal(m.overrides.get("n-a")?.id, "n-a");
});

test("a pack word with an existing id replaces it in place", () => {
  const m = mergeWords(base, { rows: [row("b1", 2, "corrected")], entries: [entry("b1")] });
  assert.equal(m.rows.length, 5);
  assert.equal(m.rows[2][2], "corrected");
  assert.equal(m.added, 0);
});

test("rows without an entry are ignored, and later packs win", () => {
  const m = mergeWords(base, { rows: [row("ghost", 0), row("x", 1, "first"), row("x", 1, "second")], entries: [entry("x")] });
  assert.equal(m.rows.some((r) => r[0] === "ghost"), false);
  assert.equal(m.rows.find((r) => r[0] === "x")?.[2], "second");
});

test("a word easier than everything goes first; nothing to merge changes nothing", () => {
  const hard = [row("c1", 4), row("c2", 5)];
  const m = mergeWords(hard, { rows: [row("easy", 0)], entries: [entry("easy")] });
  assert.equal(m.rows[0][0], "easy");
  const same = mergeWords(base, { rows: [], entries: [] });
  assert.deepEqual(same.rows, base);
});
