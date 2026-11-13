import { PackError } from "./spec";

/**
 * 加密与授权（只用 Web Crypto，浏览器和 Node 通用）。
 *
 * - 单词包里的每个文件用 AES-256-GCM 加密，密钥由发行方的主密钥按「包编号 + 密钥版本」派生（HKDF）。
 * - 授权码（激活码）= 发行方用 ECDSA P-256 签名的一段数据，里面带着客户买到的那几个包的密钥：
 *     · 通用码：密钥直接放在码里，任何设备都能用；
 *     · 绑定码：密钥用「这台设备的公钥」加密（ECDH + AES-GCM），只有生成这个设备码的设备能解开。
 * - 设备密钥是在手机里生成的不可导出私钥，设备码就是它的公钥。
 */

export type LicenseReason = "none" | "invalid" | "expired" | "device" | "key";

export class LicenseError extends PackError {
  reason: LicenseReason;
  constructor(message: string, reason: LicenseReason) {
    super(message);
    this.reason = reason;
  }
}

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const bs = (u: Uint8Array) => u as unknown as BufferSource;

export const LICENSE_PREFIX = "PHEMOR1.";
export const DEVICE_PREFIX = "PHD1.";
export const CRYPT_ALG = "A256GCM";

/* ---------- 编码 ---------- */

export function toB64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text))
    throw new LicenseError("激活码里有无法识别的字符。", "invalid");
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** JSON with sorted keys, so the signed bytes are the same everywhere. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/* ---------- 单词包文件加密 ---------- */

const aad = (packId: string, path: string) =>
  enc.encode(`phemor|${packId}|${path}`);

export async function derivePackKey(
  master: Uint8Array,
  packId: string,
  kv: number,
): Promise<Uint8Array> {
  const base = await subtle().importKey("raw", bs(master), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await subtle().deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("phemor-pack-v1"),
      info: enc.encode(`pack:${packId}:${kv}`),
    },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export const aesKey = (raw: Uint8Array) =>
  subtle().importKey("raw", bs(raw), "AES-GCM", false, ["encrypt", "decrypt"]);

/** iv(12) + 密文 + 认证标签(16)。路径和包编号参与认证，文件不能被挪到别处。 */
export async function encryptBytes(
  key: CryptoKey,
  plain: Uint8Array,
  packId: string,
  path: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: bs(aad(packId, path)),
        tagLength: 128,
      },
      key,
      bs(plain),
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function decryptBytes(
  key: CryptoKey,
  stored: Uint8Array,
  packId: string,
  path: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (stored.length < 28) throw new PackError(`文件 ${path} 已损坏。`);
  try {
    const plain = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: bs(stored.subarray(0, 12)),
        additionalData: bs(aad(packId, path)),
        tagLength: 128,
      },
      key,
      bs(stored.subarray(12)),
    );
    return new Uint8Array(plain);
  } catch {
    throw new LicenseError(
      "解密失败：激活码和这个单词包不匹配（可能是旧版本的包），请向老师换新的激活码。",
      "key",
    );
  }
}

/* ---------- 设备 ---------- */

export interface DeviceKeys {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
}

export async function generateDevice(): Promise<DeviceKeys> {
  const pair = await subtle().generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return {
    privateKey: pair.privateKey,
    publicRaw: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)),
  };
}

export const deviceCode = (publicRaw: Uint8Array) =>
  DEVICE_PREFIX + toB64u(publicRaw);

export function parseDeviceCode(code: string): Uint8Array<ArrayBuffer> {
  const t = code.replace(/\s+/g, "");
  if (!t.startsWith(DEVICE_PREFIX))
    throw new LicenseError("设备码格式不对（应以 PHD1. 开头）。", "invalid");
  const raw = fromB64u(t.slice(DEVICE_PREFIX.length));
  if (raw.length !== 65 || raw[0] !== 4)
    throw new LicenseError("设备码不完整，请重新复制。", "invalid");
  return raw;
}

/** 给人看的设备尾号，例如 A1B2-C3D4。 */
export async function fingerprint(publicRaw: Uint8Array): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", bs(publicRaw)));
  const hex = Array.from(h.subarray(0, 4), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

async function wrapKey(shared: ArrayBuffer, lid: string, usage: KeyUsage[]) {
  const base = await subtle().importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("phemor-license-v1"),
      info: enc.encode(`lid:${lid}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

/* ---------- 授权码 ---------- */

export interface KeyGrant {
  kv: number;
  k: string;
}

export type KeyDelivery =
  | { mode: "plain"; keys: Record<string, KeyGrant> }
  | { mode: "ecdh"; epk: string; iv: string; ct: string };

export interface LicenseClaims {
  v: 1;
  lid: string;
  cust: string;
  iat: number;
  exp: number | null;
  packs: string[];
  /** 绑定的设备尾号；通用码为 null。 */
  dev: string | null;
  kd: KeyDelivery;
}

export interface License extends LicenseClaims {
  sig: string;
}

export interface IssueOptions {
  signKey: CryptoKey;
  master: Uint8Array;
  lid: string;
  cust: string;
  packs: { id: string; kv: number }[];
  /** 有效天数；不填就是长期有效。到期只影响「新装、更新」，已装好的内容不受影响。 */
  days?: number | null;
  /** 客户发来的设备码；不填就是通用码。 */
  deviceCode?: string;
  now?: number;
}

export async function importSigningKey(jwk: JsonWebKey) {
  return subtle().importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function issueLicense(o: IssueOptions): Promise<string> {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const grants: Record<string, KeyGrant> = {};
  for (const p of o.packs)
    grants[p.id] = {
      kv: p.kv,
      k: toB64u(await derivePackKey(o.master, p.id, p.kv)),
    };
  let kd: KeyDelivery;
  let dev: string | null = null;
  if (o.deviceCode) {
    const raw = parseDeviceCode(o.deviceCode);
    dev = await fingerprint(raw);
    const devPub = await subtle().importKey(
      "raw",
      bs(raw),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const eph = await subtle().generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const shared = await subtle().deriveBits(
      { name: "ECDH", public: devPub },
      eph.privateKey,
      256,
    );
    const key = await wrapKey(shared, o.lid, ["encrypt"]);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await subtle().encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: bs(enc.encode(o.lid)),
          tagLength: 128,
        },
        key,
        bs(enc.encode(JSON.stringify(grants))),
      ),
    );
    kd = {
      mode: "ecdh",
      epk: toB64u(
        new Uint8Array(await subtle().exportKey("raw", eph.publicKey)),
      ),
      iv: toB64u(iv),
      ct: toB64u(ct),
    };
  } else kd = { mode: "plain", keys: grants };
  const claims: LicenseClaims = {
    v: 1,
    lid: o.lid,
    cust: o.cust,
    iat,
    exp: o.days ? iat + Math.round(o.days * 86400) : null,
    packs: o.packs.map((p) => p.id),
    dev,
    kd,
  };
  const sig = new Uint8Array(
    await subtle().sign(
      { name: "ECDSA", hash: "SHA-256" },
      o.signKey,
      bs(enc.encode(canonical(claims))),
    ),
  );
  return (
    LICENSE_PREFIX +
    toB64u(enc.encode(JSON.stringify({ ...claims, sig: toB64u(sig) })))
  );
}

export function parseLicense(code: string): License {
  const t = code.replace(/[\s"'“”‘’]+/g, "");
  if (!t.startsWith(LICENSE_PREFIX))
    throw new LicenseError(
      "激活码格式不对（应以 PHEMOR1. 开头），请完整复制。",
      "invalid",
    );
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(fromB64u(t.slice(LICENSE_PREFIX.length))));
  } catch (e) {
    if (e instanceof LicenseError) throw e;
    throw new LicenseError("激活码不完整，请重新复制整段。", "invalid");
  }
  const o = v as Partial<License> | null;
  const ok =
    !!o &&
    o.v === 1 &&
    typeof o.lid === "string" &&
    typeof o.cust === "string" &&
    typeof o.iat === "number" &&
    (o.exp === null || typeof o.exp === "number") &&
    Array.isArray(o.packs) &&
    o.packs.every((p) => typeof p === "string") &&
    (o.dev === null || typeof o.dev === "string") &&
    typeof o.sig === "string" &&
    !!o.kd &&
    (o.kd.mode === "plain" || o.kd.mode === "ecdh");
  if (!ok) throw new LicenseError("激活码不完整，请重新复制整段。", "invalid");
  return o as License;
}

/** 检查签名和有效期。issuer 是发行方公钥（JWK）。 */
export async function verifyLicense(
  code: string,
  issuer: JsonWebKey,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<License> {
  const lic = parseLicense(code);
  const { sig, ...claims } = lic;
  let good = false;
  try {
    const key = await subtle().importKey(
      "jwk",
      issuer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    good = await subtle().verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      bs(fromB64u(sig)),
      bs(enc.encode(canonical(claims))),
    );
  } catch {
    good = false;
  }
  if (!good)
    throw new LicenseError(
      "这个激活码无效（不是老师签发的，或者复制时被改动了）。",
      "invalid",
    );
  if (lic.exp !== null && nowSec > lic.exp)
    throw new LicenseError("这个激活码已过期，请向老师续期。", "expired");
  return lic;
}

/** 取出这个激活码里的各包密钥。绑定码需要本机的设备私钥。 */
export async function unwrapGrants(
  lic: License,
  device?: DeviceKeys & { fp?: string },
): Promise<Record<string, KeyGrant>> {
  if (lic.kd.mode === "plain") return lic.kd.keys;
  if (!device)
    throw new LicenseError(
      "这个激活码是绑定设备的，但本机还没有设备码。",
      "device",
    );
  if (lic.dev && device.fp && lic.dev !== device.fp)
    throw new LicenseError(
      `这个激活码是发给另一台设备的（设备尾号 ${lic.dev}），本机是 ${device.fp}。请把本机的设备码发给老师重新获取。`,
      "device",
    );
  try {
    const epk = await subtle().importKey(
      "raw",
      bs(fromB64u(lic.kd.epk)),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const shared = await subtle().deriveBits(
      { name: "ECDH", public: epk },
      device.privateKey,
      256,
    );
    const key = await wrapKey(shared, lic.lid, ["decrypt"]);
    const plain = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: bs(fromB64u(lic.kd.iv)),
        additionalData: bs(enc.encode(lic.lid)),
        tagLength: 128,
      },
      key,
      bs(fromB64u(lic.kd.ct)),
    );
    return JSON.parse(dec.decode(plain)) as Record<string, KeyGrant>;
  } catch (e) {
    if (e instanceof LicenseError) throw e;
    throw new LicenseError(
      "这个激活码不是发给本机的，无法使用。请把本机的设备码发给老师重新获取。",
      "device",
    );
  }
}
