/* 激活码工具（只在你自己的电脑上运行，私钥和主密钥绝不能上传）。
 *
 *   npm run license -- init                       生成主密钥和签名密钥，把公钥写进 src/packs/issuer.ts
 *   npm run license -- release --in packs/lists --out <夸克文件夹>
 *                                                  初中包原样复制，其余四个加密后输出
 *   npm run license -- issue --customer 张三 --packs all [--device PHD1.xxx] [--days 365] [--show-name]
 *       客户名只记在你自己的 issued.csv 里；加 --show-name 才把名字写进激活码，客户手机上会显示出来（威慑用）
 *   npm run license -- batch customers.csv --out codes.csv
 *   npm run license -- show <激活码>
 *
 * 联网激活（每个序列号限 6 台设备，见 docs/license.md「联网激活」）：
 *   npm run license -- serial new --count 200 [--packs all] [--max 6] [--note 店铺A] [--out DIR]
 *       批量生成序列号：serials-*.txt 给店铺自动发货，serials-*.sql 导入云端数据库
 *   npm run license -- serial status|reset|revoke <序列号>      打印对应的数据库命令（查看名额 / 清零名额 / 停用）
 *   npm run license -- encrypt a.phemor b.phemor --out DIR      （release 用的底层命令）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSerial, generateSerial, hashSerial, normalizeSerial } from "../../src/packs/serial.ts";
import { CRYPT_ALG, derivePackKey, encryptBytes, aesKey, fingerprint, importSigningKey, issueLicense, parseDeviceCode, verifyLicense } from "../../src/packs/crypto.ts";
import { checkManifest } from "../../src/packs/spec.ts";
import { readZipDirectory, readZipEntry } from "../../src/packs/zip.ts";
import { writeZip, type ZipItem } from "./zipwrite.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const products = JSON.parse(fs.readFileSync(path.join(here, "products.json"), "utf8")) as {
  kv: number;
  packs: { id: string; name: string; alias: string[]; free: boolean; file: string }[];
};
const premium = products.packs.filter((p) => !p.free);
const dir = process.env.PHEMOR_LICENSE_DIR || path.join(os.homedir(), ".phemor-license");
const file = (n: string) => path.join(dir, n);

const die = (msg: string): never => {
  console.error(`\n× ${msg}\n`);
  process.exit(1);
};

function opts(args: string[]) {
  const pos: string[] = [];
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) o[k] = "true";
      else {
        o[k] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, o };
}

function loadKeys() {
  if (!fs.existsSync(file("master.key"))) die(`还没有密钥。先运行：npm run license -- init\n（密钥目录：${dir}）`);
  const master = Buffer.from(fs.readFileSync(file("master.key"), "utf8").trim(), "hex");
  const priv = JSON.parse(fs.readFileSync(file("issuer-private.jwk"), "utf8")) as JsonWebKey;
  const pub = JSON.parse(fs.readFileSync(file("issuer-public.jwk"), "utf8")) as JsonWebKey;
  if (master.length !== 32) die("master.key 不是 32 字节，文件可能损坏了。");
  return { master: new Uint8Array(master), priv, pub };
}

/* ---------- init ---------- */
async function init(o: Record<string, string>) {
  if (fs.existsSync(file("master.key")) && !o.force)
    die(`${dir} 里已经有密钥了。重新生成会让所有已发出的激活码和已加密的包作废。\n确实要重新生成请加 --force（先备份旧目录！）。`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const master = crypto.randomBytes(32);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pubFull = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pub = { kty: pubFull.kty, crv: pubFull.crv, x: pubFull.x, y: pubFull.y };
  fs.writeFileSync(file("master.key"), master.toString("hex") + "\n", { mode: 0o600 });
  fs.writeFileSync(file("issuer-private.jwk"), JSON.stringify(priv) + "\n", { mode: 0o600 });
  fs.writeFileSync(file("issuer-public.jwk"), JSON.stringify(pub) + "\n", { mode: 0o644 });
  const target = path.join(root, "src/packs/issuer.ts");
  if (!o["no-source"]) {
    let src = fs.readFileSync(target, "utf8");
    src = src.replace(/export const ISSUER_PUBLIC_KEY: JsonWebKey \| null = [\s\S]*?;\s*$/m, `export const ISSUER_PUBLIC_KEY: JsonWebKey | null = ${JSON.stringify(pub)};\n`);
    fs.writeFileSync(target, src);
  }
  console.log(`✓ 已生成密钥，保存在 ${dir}`);
  console.log("  master.key         主密钥（决定所有包的加密密钥）  ← 绝不能上传，必须备份");
  console.log("  issuer-private.jwk 签名私钥（用来签发激活码）      ← 绝不能上传，必须备份");
  console.log("  issuer-public.jwk  公钥（可以公开）");
  if (!o["no-source"]) console.log(`✓ 公钥已写入 ${path.relative(root, target)}，请重新构建并发布网页（更新 GitHub）。`);
  console.log("\n! 请立刻把整个密钥目录复制一份到 U 盘/加密备份。丢了就没法再给新客户签发激活码，也没法更新加密包。");
}

/* ---------- encrypt ---------- */
async function encryptPack(inFile: string, outFile: string, master: Uint8Array, kv: number) {
  const blob = await fs.openAsBlob(inFile);
  const dirEntries = await readZipDirectory(blob);
  const by = new Map(dirEntries.map((e) => [e.name, e]));
  const pj = by.get("pack.json");
  if (!pj) throw new Error(`${inFile}: 缺少 pack.json`);
  const raw = JSON.parse(new TextDecoder().decode(await readZipEntry(blob, pj))) as Record<string, unknown>;
  if (raw.crypt) throw new Error(`${inFile}: 已经是加密包，请从明文包开始。`);
  const id = String(raw.id);
  const key = await aesKey(await derivePackKey(master, id, kv));
  const manifest = { ...raw, format: 2, crypt: { alg: CRYPT_ALG, kv } };
  checkManifest(manifest); // 用手机端同一套检查
  async function* items(): AsyncGenerator<ZipItem> {
    yield { name: "pack.json", data: new TextEncoder().encode(JSON.stringify(manifest)) };
    const wj = by.get("words.json");
    if (wj) yield { name: "words.json", data: await encryptBytes(key, await readZipEntry(blob, wj), id, "words.json") };
    for (const e of dirEntries) {
      if (e.name === "pack.json" || e.name === "words.json") continue;
      if (!e.name.startsWith("files/")) throw new Error(`${inFile}: 意外的文件 ${e.name}`);
      yield { name: e.name, data: await encryptBytes(key, await readZipEntry(blob, e), id, e.name.slice(6)) };
    }
  }
  const tmp = `${outFile}.tmp`;
  await writeZip(tmp, items());
  fs.renameSync(tmp, outFile);
  return { id, files: dirEntries.length, bytes: fs.statSync(outFile).size };
}

async function encrypt(files: string[], o: Record<string, string>) {
  if (!files.length || !o.out) die("用法：npm run license -- encrypt a.phemor b.phemor --out 输出文件夹 [--kv 1]");
  const { master } = loadKeys();
  fs.mkdirSync(o.out, { recursive: true });
  const kv = Number(o.kv || products.kv);
  for (const f of files) {
    const out = path.join(o.out, path.basename(f));
    const r = await encryptPack(f, out, master, kv);
    console.log(`✓ ${r.id}  → ${out}  (${(r.bytes / 1e6).toFixed(0)} MB, 密钥版本 ${kv})`);
  }
}

/* ---------- release ---------- */
async function release(o: Record<string, string>) {
  if (!o.in || !o.out) die("用法：npm run license -- release --in packs/lists --out \"…/上传夸克/非莫单词包\"");
  const { master } = loadKeys();
  fs.mkdirSync(o.out, { recursive: true });
  for (const p of products.packs) {
    const src = path.join(o.in, `${p.id}.phemor`);
    if (!fs.existsSync(src)) die(`找不到 ${src}`);
    const dst = path.join(o.out, p.file);
    if (p.free) {
      fs.copyFileSync(src, dst);
      console.log(`✓ ${p.file}  明文（免费基础包）`);
    } else {
      const r = await encryptPack(src, dst, master, products.kv);
      console.log(`✓ ${p.file}  已加密 (${(r.bytes / 1e6).toFixed(0)} MB)`);
    }
  }
  console.log(`\n完成。把 ${o.out} 里的文件上传到夸克网盘即可。`);
}

/* ---------- issue ---------- */
function resolvePacks(spec: string) {
  if (!spec || spec === "all") return premium;
  const out = [];
  for (const t of spec.split(/[,，、\s]+/).filter(Boolean)) {
    const p = products.packs.find((x) => x.id === t || x.name === t || x.alias.includes(t));
    if (!p) return die(`不认识的包：${t}。可用：${products.packs.map((x) => x.name).join("、")}，或 all`);
    if (p.free) continue; // 基础包不需要激活码
    if (!out.includes(p)) out.push(p);
  }
  if (!out.length) die("没有需要激活码的包（初中包是免费的）。");
  return out;
}

const csvq = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function makeCode(customer: string, packSpec: string, device: string | undefined, days: number | undefined, showName = false) {
  const { master, priv } = loadKeys();
  const packs = resolvePacks(packSpec);
  const lid = "L" + crypto.randomBytes(6).toString("hex");
  const code = await issueLicense({
    signKey: await importSigningKey(priv),
    master,
    lid,
    cust: showName ? customer : "",
    packs: packs.map((p) => ({ id: p.id, kv: products.kv })),
    days: days ?? null,
    deviceCode: device || undefined,
  });
  const fp = device ? await fingerprint(parseDeviceCode(device)) : "";
  const exp = days ? new Date(Date.now() + days * 864e5).toISOString().slice(0, 10) : "";
  const logf = file("issued.csv");
  if (!fs.existsSync(logf)) fs.writeFileSync(logf, "date,lid,customer,packs,device,expires,code\n", { mode: 0o600 });
  fs.appendFileSync(logf, [new Date().toISOString(), lid, customer, packs.map((p) => p.name).join("+"), fp, exp, code].map(csvq).join(",") + "\n");
  return { code, lid, packs, fp, exp };
}

async function issue(o: Record<string, string>) {
  const customer = o.customer || o.c || "（未填）";
  if (customer === "true") die("用法：npm run license -- issue --customer 张三 --packs all [--device PHD1.…] [--days 365] [--show-name]");
  if (o["show-name"] && customer === "（未填）") die("--show-name 需要同时写 --customer 客户名");
  const days = o.days ? Number(o.days) : undefined;
  if (days !== undefined && !(days > 0)) die("--days 必须是正数");
  if (o.device && !o.device.trim().startsWith("PHD1.")) die("设备码应以 PHD1. 开头，请让客户重新复制。");
  const r = await makeCode(customer, o.packs || "all", o.device?.trim(), days, !!o["show-name"]);
  console.log(`客户（仅记录）：${customer}${o["show-name"] ? "，名字会显示在客户手机上" : "，名字不写进激活码"}   包：${r.packs.map((p) => p.name).join("、")}   ${r.fp ? `仅限设备 ${r.fp}` : "通用码（不绑定设备）"}   ${r.exp ? `有效至 ${r.exp}` : "长期有效"}\n`);
  console.log(r.code + "\n");
  console.log(`（已记入 ${file("issued.csv")}）`);
}

/* ---------- batch ---------- */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === "，") (row.push(cur), (cur = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

async function batch(inFile: string | undefined, o: Record<string, string>) {
  if (!inFile || !fs.existsSync(inFile)) die("用法：npm run license -- batch customers.csv --out codes.csv\n表头：customer,packs,device,days（packs 空=全部，device/days 可空）");
  const rows = parseCsv(fs.readFileSync(inFile, "utf8").replace(/^﻿/, ""));
  const head = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (n: string) => head.indexOf(n);
  if (col("customer") < 0) die("表头里要有 customer 这一列。");
  const out = ["customer,packs,device,days,code"];
  for (const r of rows) {
    const get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? "").trim() : "");
    const customer = get("customer");
    if (!customer) continue;
    const days = get("days") ? Number(get("days")) : undefined;
    const res = await makeCode(customer, get("packs") || "all", get("device") || undefined, days, o["show-name"] === "true");
    out.push([customer, res.packs.map((p) => p.name).join("+"), res.fp, days ?? "", res.code].map((x) => csvq(String(x))).join(","));
    console.log(`✓ ${customer}`);
  }
  const target = o.out || "codes.csv";
  fs.writeFileSync(target, "﻿" + out.join("\n") + "\n");
  console.log(`\n已生成 ${out.length - 1} 个激活码 → ${target}`);
}

/* ---------- serial（联网激活用的序列号） ---------- */
const sqlq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const wranglerCmd = (sql: string, kind: "file" | "command") => `cd ${path.join(root, "worker")} && npx wrangler d1 execute phemor --remote --${kind} ${kind === "file" ? sql : JSON.stringify(sql)}`;

async function serialCmd(pos: string[], o: Record<string, string>) {
  const sub = pos[0];
  if (sub === "new") {
    const count = Number(o.count ?? "");
    if (!Number.isInteger(count) || count < 1 || count > 20000) die("用法：npm run license -- serial new --count 200 [--packs all] [--max 6] [--note 店铺A] [--out DIR]\n（--count 是 1~20000 的整数）");
    const max = o.max ? Number(o.max) : 6;
    if (!Number.isInteger(max) || max < 1 || max > 100) die("--max 要是 1~100 的整数");
    const packs = resolvePacks(o.packs || "all");
    if (!packs.length) die("没有选中任何需要激活码的包。");
    const note = o.note && o.note !== "true" ? o.note : "";
    const out = o.out && o.out !== "true" ? path.resolve(o.out) : dir;
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const now = Math.floor(Date.now() / 1000);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const base = path.join(out, `serials-${stamp}-${count}`);
    const seen = new Set<string>();
    const serials: string[] = [];
    while (serials.length < count) {
      const sn = generateSerial();
      if (!seen.has(sn)) {
        seen.add(sn);
        serials.push(sn);
      }
    }
    const packJson = JSON.stringify(packs.map((p) => p.id));
    const rows: string[] = [];
    const log: string[] = [];
    for (const sn of serials) {
      const h = await hashSerial(normalizeSerial(sn)!);
      rows.push(`(${sqlq(h)}, ${sqlq(packJson)}, ${max}, ${sqlq(note)}, 0, ${now})`);
      log.push([new Date().toISOString(), sn, packs.map((p) => p.name).join("+"), max, note].map((x) => csvq(String(x))).join(","));
    }
    // 每条 INSERT 放 200 行：单条语句不超过 D1 的 100KB 上限，导入也比逐条快得多
    const lines: string[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      lines.push(`INSERT OR IGNORE INTO serials (hash, packs, max_devices, note, revoked, created) VALUES\n${rows.slice(i, i + 200).join(",\n")};`);
    }
    fs.writeFileSync(`${base}.txt`, serials.join("\n") + "\n", { mode: 0o600 });
    fs.writeFileSync(`${base}.sql`, lines.join("\n") + "\n", { mode: 0o600 });
    const logf = file("serials.csv");
    if (!fs.existsSync(logf)) fs.writeFileSync(logf, "date,serial,packs,max_devices,note\n", { mode: 0o600 });
    fs.appendFileSync(logf, log.join("\n") + "\n");
    console.log(`已生成 ${count} 个序列号（${packs.map((p) => p.name).join("、")}，每个最多 ${max} 台设备）\n`);
    console.log(`  序列号（给店铺/客户，要保密）：${base}.txt`);
    console.log(`  导入云端数据库的 SQL（只含哈希）：${base}.sql\n`);
    console.log(`下一步：先把 SQL 导入云端数据库，再上架序列号\n  ${wranglerCmd(`${base}.sql`, "file")}\n`);
    return;
  }
  if (sub === "status" || sub === "reset" || sub === "revoke") {
    const sn = pos[1] ? normalizeSerial(pos[1]) : null;
    if (!sn) die(`用法：npm run license -- serial ${sub} K7M2-9QXR-4TNB-W3HC`);
    const h = await hashSerial(sn!);
    const sql =
      sub === "status"
        ? `SELECT (SELECT COUNT(*) FROM activations WHERE hash = ${sqlq(h)}) AS used, max_devices, revoked, note FROM serials WHERE hash = ${sqlq(h)}`
        : sub === "reset"
          ? `DELETE FROM activations WHERE hash = ${sqlq(h)}`
          : `UPDATE serials SET revoked = 1 WHERE hash = ${sqlq(h)}`;
    console.log(`序列号 ${formatSerial(sn!)}：请运行下面这条命令${sub === "reset" ? "（名额清零，客户可以重新在 6 台设备上激活，已激活的设备不受影响）" : sub === "revoke" ? "（停用后不能再激活新设备，已激活的设备不受影响）" : "（used 是已激活的设备数）"}\n\n  ${wranglerCmd(sql, "command")}\n`);
    return;
  }
  die("用法：npm run license -- serial new|status|reset|revoke ...\n  serial new --count 200 [--packs all] [--max 6] [--note 店铺A] [--out DIR]\n  serial status|reset|revoke <序列号>");
}

/* ---------- show ---------- */
async function show(code: string | undefined) {
  if (!code) die("用法：npm run license -- show <激活码>");
  const { pub } = loadKeys();
  try {
    const lic = await verifyLicense(code!, pub, Math.floor(Date.now() / 1000));
    console.log(`✓ 签名有效\n  客户名：${lic.cust || "（未写入激活码）"}\n  编号：${lic.lid}\n  包：${lic.packs.join("、")}\n  设备：${lic.dev ?? "通用（不绑定）"}\n  签发：${new Date(lic.iat * 1000).toLocaleString("zh-CN")}\n  到期：${lic.exp ? new Date(lic.exp * 1000).toLocaleDateString("zh-CN") : "长期有效"}`);
  } catch (e) {
    die(`${(e as Error).message}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, o } = opts(rest);
switch (cmd) {
  case "init":
    await init(o);
    break;
  case "encrypt":
    await encrypt(pos, o);
    break;
  case "release":
    await release(o);
    break;
  case "issue":
    await issue(o);
    break;
  case "batch":
    await batch(pos[0], o);
    break;
  case "show":
    await show(pos[0]);
    break;
  case "serial":
    await serialCmd(pos, o);
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\* ?/, ""));
}
