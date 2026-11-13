import assert from "node:assert/strict";
import test from "node:test";
import { aesKey, decryptBytes, derivePackKey, deviceCode, encryptBytes, fingerprint, generateDevice, importSigningKey, issueLicense, LicenseError, parseDeviceCode, toB64u, fromB64u, unwrapGrants, verifyLicense, canonical, type DeviceKeys } from "./crypto.ts";

const master = crypto.getRandomValues(new Uint8Array(32));

async function issuer() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pub, signKey: await importSigningKey(priv) };
}
const packs = [
  { id: "list-senior", kv: 1 },
  { id: "list-college", kv: 1 },
];

test("base64url round trip and canonical json", () => {
  const b = crypto.getRandomValues(new Uint8Array(1000));
  assert.deepEqual(fromB64u(toB64u(b)), b);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});

test("pack files round trip and are bound to pack id and path", async () => {
  const key = await aesKey(await derivePackKey(master, "list-senior", 1));
  const plain = new TextEncoder().encode("hello 你好");
  const stored = await encryptBytes(key, plain, "list-senior", "atlas/img/a.webp");
  assert.equal(stored.length, plain.length + 28);
  assert.deepEqual(await decryptBytes(key, stored, "list-senior", "atlas/img/a.webp"), plain);
  await assert.rejects(decryptBytes(key, stored, "list-senior", "atlas/img/b.webp"), LicenseError);
  await assert.rejects(decryptBytes(key, stored, "list-college", "atlas/img/a.webp"), LicenseError);
  const other = await aesKey(await derivePackKey(master, "list-senior", 2));
  await assert.rejects(decryptBytes(other, stored, "list-senior", "atlas/img/a.webp"), LicenseError);
  const bad = stored.slice();
  bad[20] ^= 1;
  await assert.rejects(decryptBytes(key, bad, "list-senior", "atlas/img/a.webp"), LicenseError);
});

test("key derivation is stable and per pack", async () => {
  const a = await derivePackKey(master, "list-senior", 1);
  assert.deepEqual(a, await derivePackKey(master, "list-senior", 1));
  assert.notDeepEqual(a, await derivePackKey(master, "list-college", 1));
  assert.notDeepEqual(a, await derivePackKey(master, "list-senior", 2));
});

test("universal code: signature, expiry, tamper", async () => {
  const { pub, signKey } = await issuer();
  const code = await issueLicense({ signKey, master, lid: "L1", cust: "客户A", packs, days: 30, now: 1_700_000_000_000 });
  const lic = await verifyLicense(code, pub, 1_700_000_100);
  assert.equal(lic.cust, "客户A");
  assert.equal(lic.dev, null);
  const grants = await unwrapGrants(lic);
  assert.deepEqual(Object.keys(grants).sort(), ["list-college", "list-senior"]);
  assert.equal(grants["list-senior"].k, toB64u(await derivePackKey(master, "list-senior", 1)));
  await assert.rejects(verifyLicense(code, pub, 1_700_000_000 + 31 * 86400), /过期/);
  // 换成别人的公钥：签名不对
  const other = await issuer();
  await assert.rejects(verifyLicense(code, other.pub, 1_700_000_100), /无效/);
  // 改客户名或有效期：签名不对
  const obj = JSON.parse(new TextDecoder().decode(fromB64u(code.slice(8))));
  obj.cust = "客户B";
  const forged = "PHEMOR1." + toB64u(new TextEncoder().encode(JSON.stringify(obj)));
  await assert.rejects(verifyLicense(forged, pub, 1_700_000_100), /无效/);
  // 粘贴时带了空格、换行、引号
  const messy = `  "${code.slice(0, 50)}\n${code.slice(50)}"  `;
  assert.equal((await verifyLicense(messy, pub, 1_700_000_100)).lid, "L1");
  await assert.rejects(verifyLicense("hello", pub), /格式/);
  await assert.rejects(verifyLicense(code.slice(0, 40), pub), LicenseError);
});

test("device-bound code works only on its own device", async () => {
  const { pub, signKey } = await issuer();
  const a = await generateDevice();
  const b = await generateDevice();
  const withFp = async (d: DeviceKeys) => ({ ...d, fp: await fingerprint(d.publicRaw) });
  const code = await issueLicense({ signKey, master, lid: "L2", cust: "客户A", packs, deviceCode: deviceCode(a.publicRaw) });
  const lic = await verifyLicense(code, pub);
  assert.equal(lic.dev, await fingerprint(a.publicRaw));
  // 密钥不能直接从码里读出来
  assert.ok(!code.includes(toB64u(await derivePackKey(master, "list-senior", 1))));
  assert.ok(!JSON.stringify(lic).includes(toB64u(await derivePackKey(master, "list-senior", 1))));
  const ok = await unwrapGrants(lic, await withFp(a));
  assert.equal(ok["list-college"].k, toB64u(await derivePackKey(master, "list-college", 1)));
  await assert.rejects(unwrapGrants(lic, await withFp(b)), /另一台设备/);
  // 即使有人改了源码跳过尾号检查，别的设备的私钥也解不开
  await assert.rejects(unwrapGrants(lic, b), /不是发给本机/);
  await assert.rejects(unwrapGrants(lic), /设备码/);
});

test("device code parsing", async () => {
  const d = await generateDevice();
  const code = deviceCode(d.publicRaw);
  assert.deepEqual(parseDeviceCode(`  ${code.slice(0, 30)}\n${code.slice(30)} `), d.publicRaw);
  assert.throws(() => parseDeviceCode("PHD1.abc"), /不完整/);
  assert.throws(() => parseDeviceCode("xyz"), /格式/);
});
