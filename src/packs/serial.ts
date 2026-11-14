/** 序列号：卖给客户的短码（如 K7M2-9QXR-4TNB-W3HC），联网换成绑定本机的激活码。纯函数，网页、Worker、命令行共用。 */

/** 去掉了容易看错的 0 O 1 I L，共 31 个字符；16 位 ≈ 79 bit，猜不出来。 */
export const SERIAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SERIAL_LENGTH = 16;

/** 把用户粘贴的内容整理成 16 位大写序列号；格式不对返回 null。 */
export function normalizeSerial(text: string): string | null {
  const s = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== SERIAL_LENGTH) return null;
  for (const ch of s) if (!SERIAL_ALPHABET.includes(ch)) return null;
  return s;
}

export const formatSerial = (norm: string) => norm.match(/.{4}/g)!.join("-");

/** 看起来像序列号（而不是 PHEMOR1. 开头的离线激活码）。 */
export function looksLikeSerial(text: string): boolean {
  const t = text.trim();
  return !/^PHEMOR1\./i.test(t) && normalizeSerial(t) !== null;
}

/** 随机生成一个序列号（用拒绝采样，每个字符等概率）。 */
export function generateSerial(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const limit = 256 - (256 % SERIAL_ALPHABET.length);
  let out = "";
  while (out.length < SERIAL_LENGTH) {
    for (const b of random(32)) {
      if (b < limit && out.length < SERIAL_LENGTH) out += SERIAL_ALPHABET[b % SERIAL_ALPHABET.length];
    }
  }
  return formatSerial(out);
}

/** 数据库里只存序列号的哈希，库泄露也拿不到序列号本身。 */
export async function hashSerial(norm: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`phemor-serial-v1|${norm}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
