/* 检查单词包：用和手机端完全相同的读取代码打开每个 .phemor，核对清单、路径白名单、校验和、词条数据。
 * 用法：npx tsx scripts/pack/verify.ts packs/*.phemor */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aesKey, decryptBytes, derivePackKey } from "../../src/packs/crypto.ts";
import { allowedFile, checkManifest, sanitizeWords } from "../../src/packs/spec.ts";
import { readZipDirectory, readZipEntry } from "../../src/packs/zip.ts";

/* 加密包：如果本机有主密钥（~/.phemor-license/master.key 或环境变量 PHEMOR_LICENSE_DIR），会完整解密核对；没有就只核对结构和校验和。 */
const licDir = process.env.PHEMOR_LICENSE_DIR || path.join(os.homedir(), ".phemor-license");
const masterFile = path.join(licDir, "master.key");
const master = fs.existsSync(masterFile) ? new Uint8Array(Buffer.from(fs.readFileSync(masterFile, "utf8").trim(), "hex")) : null;

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法：npx tsx scripts/pack/verify.ts packs/*.phemor");
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  try {
    const blob = await fs.openAsBlob(f);
    const dir = await readZipDirectory(blob);
    const by = new Map(dir.map((e) => [e.name, e]));
    const pm = by.get("pack.json");
    if (!pm) throw new Error("缺少 pack.json");
    const manifest = checkManifest(JSON.parse(new TextDecoder().decode(await readZipEntry(blob, pm))));
    const key = manifest.crypt && master ? await aesKey(await derivePackKey(master, manifest.id, manifest.crypt.kv)) : null;
    const plain = async (e: (typeof dir)[number], sitePath: string) => {
      const stored = await readZipEntry(blob, e);
      if (!manifest.crypt) return stored;
      if (stored.length < 28) throw new Error(`加密文件太短：${e.name}`);
      return key ? await decryptBytes(key, stored, manifest.id, sitePath) : stored;
    };
    let words = 0;
    const wj = by.get("words.json");
    if (wj && (!manifest.crypt || key)) {
      const data = await plain(wj, "words.json");
      const w = sanitizeWords(JSON.parse(new TextDecoder().decode(data)), 19, 6);
      words = w.rows.length;
      const raw = JSON.parse(new TextDecoder().decode(data));
      if (words !== raw.rows.length) throw new Error(`词条数据有 ${raw.rows.length - words} 行不合法，会被手机端丢弃`);
    }
    let media = 0;
    let bytes = 0;
    for (const e of dir) {
      if (e.name === "pack.json" || e.name === "words.json") continue;
      if (!e.name.startsWith("files/") || !allowedFile(e.name.slice(6))) throw new Error(`不允许的文件：${e.name}`);
      bytes += (await plain(e, e.name.slice(6))).length;
      media++;
    }
    if (manifest.files !== media) throw new Error(`清单写 ${manifest.files} 个文件，实际 ${media} 个`);
    console.log(`OK  ${f}  ${manifest.id} v${manifest.version}  ${media} 个文件 ${(bytes / 1e6).toFixed(1)} MB${words ? `  ${words} 个词` : ""}${manifest.crypt ? (key ? "  [加密，已解密核对]" : "  [加密，仅核对结构]") : ""}`);
  } catch (e) {
    bad++;
    console.error(`坏  ${f}  ${(e as Error).message}`);
  }
}
process.exit(bad ? 1 : 0);
