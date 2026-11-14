import {
  aesKey,
  deviceCode,
  fingerprint,
  fromB64u,
  generateDevice,
  LicenseError,
  unwrapGrants,
  verifyLicense,
  type DeviceKeys,
  type License,
} from "./crypto";
import { idbAll, idbDelete, idbGet, idbPut } from "./idb";
import { ISSUER_PUBLIC_KEY } from "./issuer";
import { normalizeSerial } from "./serial";

/** Fired on window after an activation code is added or removed. */
export const LICENSES_CHANGED = "phemor:licenses-changed";

export interface StoredLicense {
  id: string;
  code: string;
  cust: string;
  packs: string[];
  dev: string | null;
  iat: number;
  exp: number | null;
  added: number;
}

/** 构建时可用环境变量 VITE_ISSUER_PUBLIC_KEY（JSON）覆盖，方便测试；正式版用 issuer.ts 里的公钥。 */
function issuerKey(): JsonWebKey | null {
  const env = (import.meta.env as Record<string, string | undefined>)
    .VITE_ISSUER_PUBLIC_KEY;
  if (env) {
    try {
      return JSON.parse(env) as JsonWebKey;
    } catch {
      /* fall through to the built-in key */
    }
  }
  return ISSUER_PUBLIC_KEY;
}

export const licensingEnabled = () =>
  !!issuerKey() && typeof crypto !== "undefined" && !!crypto.subtle;

/* ---------- 本机设备密钥（不可导出，存在 IndexedDB） ---------- */

export interface Device extends DeviceKeys {
  code: string;
  fp: string;
}

let devicePromise: Promise<Device> | null = null;

export function getDevice(): Promise<Device> {
  devicePromise ??= (async () => {
    let rec = await idbGet<{
      id: string;
      privateKey: CryptoKey;
      publicRaw: Uint8Array;
    }>("device", "device");
    if (!rec) {
      const d = await generateDevice();
      rec = { id: "device", privateKey: d.privateKey, publicRaw: d.publicRaw };
      await idbPut(rec, "device");
    }
    return {
      privateKey: rec.privateKey,
      publicRaw: rec.publicRaw,
      code: deviceCode(rec.publicRaw),
      fp: await fingerprint(rec.publicRaw),
    };
  })().catch((e) => {
    devicePromise = null;
    throw e;
  });
  return devicePromise;
}

/* ---------- 激活码 ---------- */

export const listLicenses = async () =>
  (await idbAll<StoredLicense>("licenses")).sort((a, b) => a.added - b.added);

export async function activate(code: string): Promise<StoredLicense> {
  const pub = issuerKey();
  if (!pub)
    throw new LicenseError(
      "这个版本的网页还没有启用授权功能，请更新网页后再试。",
      "invalid",
    );
  const lic: License = await verifyLicense(code, pub);
  // 绑定码要确认本机真的能打开，免得存了一个用不了的码
  if (lic.kd.mode === "ecdh") await unwrapGrants(lic, await getDevice());
  const rec: StoredLicense = {
    id: lic.lid,
    code: code.replace(/[\s"'“”‘’]+/g, ""),
    cust: lic.cust,
    packs: lic.packs,
    dev: lic.dev,
    iat: lic.iat,
    exp: lic.exp,
    added: Date.now(),
  };
  await idbPut(rec, "licenses");
  window.dispatchEvent(new Event(LICENSES_CHANGED));
  return rec;
}

/* ---------- 序列号联网激活 ---------- */

export interface SerialResult {
  rec: StoredLicense;
  /** 这个序列号已激活的设备数 / 上限 / 还剩几台 */
  used: number;
  max: number;
  remaining: number;
}

const ACTIVATE_URL = "/api/activate";
const UNREACHABLE =
  "连不上激活服务器。请换 Wi-Fi 或 5G 再试几次；如果一直不行，请联系老师，老师可以发离线激活码给你。";

interface ActivateReply {
  ok?: boolean;
  code?: string;
  used?: number;
  max?: number;
  remaining?: number;
  message?: string;
}

/** 向激活服务器换取绑定本机的激活码。网络不通或服务出错时自动重试 3 次；服务器明确拒绝（序列号不对、名额已满等）就直接报原因。 */
async function requestActivation(serial: string, device: string): Promise<ActivateReply & { code: string }> {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    throw new LicenseError("现在没有网络。序列号需要联网激活，请连上 Wi-Fi 或 5G 后再试。", "invalid");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 1500));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(ACTIVATE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serial, device }),
        cache: "no-store",
        signal: ctl.signal,
      });
      let data: ActivateReply | null = null;
      try {
        data = (await res.json()) as ActivateReply;
      } catch {
        data = null;
      }
      if (res.ok && data?.ok && typeof data.code === "string") return data as ActivateReply & { code: string };
      if (data && typeof data.message === "string" && res.status < 500) throw new LicenseError(data.message, "invalid");
      // 没有 JSON 回应（比如服务还没部署）或服务器出错：再试
    } catch (e) {
      if (e instanceof LicenseError) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LicenseError(UNREACHABLE, "invalid");
}

/** 输入序列号，联网换成绑定本机的激活码并保存；之后离线也能用。 */
export async function activateSerial(input: string): Promise<SerialResult> {
  const serial = normalizeSerial(input);
  if (!serial)
    throw new LicenseError("序列号格式不对，应是 16 位字母数字（如 K7M2-9QXR-4TNB-W3HC），请核对。", "invalid");
  const data = await requestActivation(serial, (await getDevice()).code);
  const rec = await activate(data.code);
  return { rec, used: data.used ?? 1, max: data.max ?? 6, remaining: data.remaining ?? 0 };
}

export async function removeLicense(id: string) {
  await idbDelete(id, "licenses");
  window.dispatchEvent(new Event(LICENSES_CHANGED));
}

/** 这个包的解密密钥；没有合适的激活码就抛出带原因的 LicenseError。 */
export async function keyForPack(
  packId: string,
  kv: number,
  packName: string,
): Promise<CryptoKey> {
  const pub = issuerKey();
  if (!pub)
    throw new LicenseError(
      "这个版本的网页还没有启用授权功能，无法安装加密的单词包。请更新网页。",
      "invalid",
    );
  let last: LicenseError | null = null;
  for (const rec of await listLicenses()) {
    if (!rec.packs.includes(packId)) continue;
    try {
      const lic = await verifyLicense(rec.code, pub);
      const grants = await unwrapGrants(
        lic,
        lic.kd.mode === "ecdh" ? await getDevice() : undefined,
      );
      const g = grants[packId];
      if (!g) continue;
      if (g.kv !== kv) {
        last = new LicenseError(
          "激活码和这个单词包的版本不匹配，请向老师换新的激活码。",
          "key",
        );
        continue;
      }
      return await aesKey(fromB64u(g.k));
    } catch (e) {
      if (e instanceof LicenseError) last = e;
      else throw e;
    }
  }
  throw (
    last ??
    new LicenseError(
      `「${packName}」需要激活码。请在下方「授权」里粘贴老师给你的激活码；还没有的话请联系老师。`,
      "none",
    )
  );
}
