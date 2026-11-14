import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { deviceCode, generateDevice, parseLicense, unwrapGrants, verifyLicense } from "../../src/packs/crypto";
import { generateSerial, hashSerial, normalizeSerial } from "../../src/packs/serial";
import { handle, type Config, type Db } from "../src/handler";

const subtle = globalThis.crypto.subtle;

/** 用 Node 自带的 SQLite 当数据库，SQL 和 Cloudflare D1 一样。 */
function makeDb(): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const db: Db = {
    async first(sql, ...args) {
      return (raw.prepare(sql).get(...(args as never[])) as never) ?? null;
    },
    async run(sql, ...args) {
      return { changes: Number(raw.prepare(sql).run(...(args as never[])).changes) };
    },
  };
  return { db, raw };
}

async function setup() {
  const sign = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privJwk = await subtle.exportKey("jwk", sign.privateKey);
  const pubJwk = await subtle.exportKey("jwk", sign.publicKey);
  const masterHex = [...globalThis.crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cfg: Config = { masterHex, issuerPrivateJwk: JSON.stringify(privJwk), packKv: 1 };
  const { db, raw } = makeDb();
  const serial = generateSerial();
  raw
    .prepare("INSERT INTO serials (hash, packs, max_devices, note, revoked, created) VALUES (?1, ?2, ?3, '', 0, 0)")
    .run(await hashSerial(normalizeSerial(serial)!), JSON.stringify(["list-senior", "list-college"]), 6);
  const call = (body: unknown, ip = "1.1.1.1") =>
    handle(new Request("https://phemor.com/api/activate", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "CF-Connecting-IP": ip } }), db, cfg);
  const newDevice = async () => {
    const d = await generateDevice();
    return { keys: d, code: deviceCode(d.publicRaw) };
  };
  return { cfg, db, raw, serial, pubJwk, call, newDevice };
}

test("正常激活：返回的激活码绑定这台设备，能解出两个包的密钥", async () => {
  const t = await setup();
  const dev = await t.newDevice();
  const res = await t.call({ serial: t.serial, device: dev.code });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean; code: string; used: number; max: number; remaining: number; packs: string[] };
  assert.equal(j.ok, true);
  assert.deepEqual(j.packs, ["list-senior", "list-college"]);
  assert.deepEqual([j.used, j.max, j.remaining], [1, 6, 5]);
  const lic = await verifyLicense(j.code, t.pubJwk);
  assert.equal(lic.kd.mode, "ecdh");
  assert.equal(lic.cust, "");
  const grants = await unwrapGrants(lic, { privateKey: dev.keys.privateKey, publicRaw: dev.keys.publicRaw });
  assert.deepEqual(Object.keys(grants).sort(), ["list-college", "list-senior"]);
});

test("别的设备解不开这个激活码", async () => {
  const t = await setup();
  const a = await t.newDevice();
  const b = await t.newDevice();
  const j = (await (await t.call({ serial: t.serial, device: a.code })).json()) as { code: string };
  const lic = parseLicense(j.code);
  await assert.rejects(unwrapGrants(lic, { privateKey: b.keys.privateKey, publicRaw: b.keys.publicRaw }));
});

test("每个序列号最多 6 台设备，第 7 台被拒绝", async () => {
  const t = await setup();
  for (let i = 1; i <= 6; i++) {
    const r = await t.call({ serial: t.serial, device: (await t.newDevice()).code });
    assert.equal(r.status, 200, `第 ${i} 台`);
    assert.equal(((await r.json()) as { used: number }).used, i);
  }
  const seventh = await t.call({ serial: t.serial, device: (await t.newDevice()).code });
  assert.equal(seventh.status, 409);
  const j = (await seventh.json()) as { error: string; message: string };
  assert.equal(j.error, "limit");
  assert.match(j.message, /6 台/);
  assert.equal((t.raw.prepare("SELECT COUNT(*) AS n FROM activations").get() as { n: number }).n, 6);
});

test("同一台设备重复激活不占名额，还能拿到新的激活码", async () => {
  const t = await setup();
  const dev = await t.newDevice();
  const first = (await (await t.call({ serial: t.serial, device: dev.code })).json()) as { code: string };
  for (let i = 0; i < 5; i++) assert.equal((await t.call({ serial: t.serial, device: dev.code })).status, 200);
  const again = (await (await t.call({ serial: t.serial, device: dev.code })).json()) as { code: string; used: number };
  assert.equal(again.used, 1);
  assert.equal(parseLicense(again.code).lid, parseLicense(first.code).lid);
  // 名额没被重复占用：再来 5 台新设备仍然可以
  for (let i = 0; i < 5; i++) assert.equal((await t.call({ serial: t.serial, device: (await t.newDevice()).code })).status, 200);
  assert.equal((await t.call({ serial: t.serial, device: (await t.newDevice()).code })).status, 409);
});

test("同时来很多请求也不会超过 6 台", async () => {
  const t = await setup();
  const devs = await Promise.all(Array.from({ length: 20 }, () => t.newDevice()));
  const rs = await Promise.all(devs.map((d) => t.call({ serial: t.serial, device: d.code })));
  assert.equal(rs.filter((r) => r.status === 200).length, 6);
  assert.equal(rs.filter((r) => r.status === 409).length, 14);
  assert.equal((t.raw.prepare("SELECT COUNT(*) AS n FROM activations").get() as { n: number }).n, 6);
});

test("序列号写小写、带空格也能用", async () => {
  const t = await setup();
  const r = await t.call({ serial: ` ${t.serial.toLowerCase().replace(/-/g, " ")} `, device: (await t.newDevice()).code });
  assert.equal(r.status, 200);
});

test("不存在的序列号、格式错误、设备码错误", async () => {
  const t = await setup();
  const dev = await t.newDevice();
  const unknown = await t.call({ serial: generateSerial(), device: dev.code });
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: string }).error, "unknown_serial");
  assert.equal((await t.call({ serial: "ABC", device: dev.code })).status, 400);
  assert.equal((await t.call({ serial: t.serial, device: "PHD1.abc" })).status, 400);
  assert.equal((await t.call({ serial: t.serial, device: "" })).status, 400);
  assert.equal((await t.call("not json")).status, 400);
  // 设备码错误时不能占名额
  assert.equal((t.raw.prepare("SELECT COUNT(*) AS n FROM activations").get() as { n: number }).n, 0);
});

test("停用的序列号不能再激活", async () => {
  const t = await setup();
  t.raw.prepare("UPDATE serials SET revoked = 1").run();
  const r = await t.call({ serial: t.serial, device: (await t.newDevice()).code });
  assert.equal(r.status, 403);
});

test("管理员重置后名额清零", async () => {
  const t = await setup();
  for (let i = 0; i < 6; i++) await t.call({ serial: t.serial, device: (await t.newDevice()).code });
  assert.equal((await t.call({ serial: t.serial, device: (await t.newDevice()).code })).status, 409);
  t.raw.prepare("DELETE FROM activations WHERE hash = ?1").run(await hashSerial(normalizeSerial(t.serial)!));
  assert.equal((await t.call({ serial: t.serial, device: (await t.newDevice()).code })).status, 200);
});

test("连续输错序列号会被限流，换个来源不受影响，不会误伤已有序列号", async () => {
  const t = await setup();
  const dev = await t.newDevice();
  for (let i = 0; i < 15; i++) assert.equal((await t.call({ serial: generateSerial(), device: dev.code }, "9.9.9.9")).status, 404);
  assert.equal((await t.call({ serial: generateSerial(), device: dev.code }, "9.9.9.9")).status, 429);
  assert.equal((await t.call({ serial: t.serial, device: dev.code }, "9.9.9.9")).status, 429);
  assert.equal((await t.call({ serial: t.serial, device: dev.code }, "8.8.8.8")).status, 200);
});

test("数据库里只有哈希，没有序列号原文", async () => {
  const t = await setup();
  await t.call({ serial: t.serial, device: (await t.newDevice()).code });
  const dump = JSON.stringify([t.raw.prepare("SELECT * FROM serials").all(), t.raw.prepare("SELECT * FROM activations").all(), t.raw.prepare("SELECT * FROM attempts").all()]);
  assert.ok(!dump.includes(t.serial.replace(/-/g, "")));
  assert.ok(!dump.includes("1.1.1.1"));
});

test("ping 和未知路径", async () => {
  const t = await setup();
  const ping = await handle(new Request("https://phemor.com/api/ping"), t.db, t.cfg);
  assert.equal(ping.status, 200);
  assert.equal((await handle(new Request("https://phemor.com/api/nope"), t.db, t.cfg)).status, 404);
  assert.equal((await handle(new Request("https://phemor.com/api/activate"), t.db, t.cfg)).status, 405);
});
