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
