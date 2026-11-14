import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { idbAll, idbCountFiles, idbDeleteFiles, idbGet, idbPut, idbPutFiles, type StoredFile } from "./idb.ts";

const file = (n: number): StoredFile => ({ id: `https://x.test/atlas/img/w${n}.webp`, type: "image/webp", data: new Blob([`pic${n}`], { type: "image/webp" }) });

test("pack files are written in batches, found by address and removed again", async () => {
  await idbPutFiles(Array.from({ length: 120 }, (_, i) => file(i)));
  assert.equal(await idbCountFiles(), 120);
  const hit = await idbGet<StoredFile>("https://x.test/atlas/img/w7.webp", "files");
  assert.equal(hit?.type, "image/webp");
  assert.equal(await hit?.data.text(), "pic7");
  await idbDeleteFiles(Array.from({ length: 70 }, (_, i) => file(i).id));
  assert.equal(await idbCountFiles(), 50);
  assert.equal(await idbGet("https://x.test/atlas/img/w7.webp", "files"), undefined);
});

test("the old stores keep working next to the new ones", async () => {
  await idbPut({ id: "list-junior", seq: 1 });
  await idbPut({ id: "legacy", value: false }, "meta");
  assert.equal((await idbAll<{ id: string }>()).length, 1);
  assert.deepEqual(await idbGet("legacy", "meta"), { id: "legacy", value: false });
});
