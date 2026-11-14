/**
 * 激活接口：客户输入序列号，换成一份绑定他这台设备的激活码。
 * 每个序列号最多激活在 max_devices（默认 6）台不同设备上；同一台设备重复激活不占名额。
 * 逻辑与 Cloudflare 无关，只依赖一个很小的数据库接口，方便在本机用 SQLite 测试。
 */
import { importSigningKey, issueLicense, parseDeviceCode } from "../../src/packs/crypto";
import { hashSerial, normalizeSerial } from "../../src/packs/serial";

export interface Db {
  first<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T | null>;
  run(sql: string, ...args: unknown[]): Promise<{ changes: number }>;
}

export interface Config {
  /** master.key 的内容（64 位十六进制） */
  masterHex: string;
  /** issuer-private.jwk 的内容（JSON 文本） */
  issuerPrivateJwk: string;
  /** 单词包密钥版本，要和 scripts/license/products.json 的 kv 一致 */
  packKv: number;
  now?: () => number;
}

const MAX_BODY = 4096;
const FAIL_WINDOW = 600; // 秒
const FAIL_LIMIT = 15; // 10 分钟内同一来源最多失败几次

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => reply(status, { ok: false, error, message, ...extra });

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256hex = async (data: Uint8Array | string) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>))));

interface SerialRow {
  hash: string;
  packs: string;
  max_devices: number;
  revoked: number;
}

export async function handle(request: Request, db: Db, cfg: Config): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor((cfg.now?.() ?? Date.now()) / 1000);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (url.pathname === "/api/ping") return reply(200, { ok: true, t: now });
  if (url.pathname !== "/api/activate") return fail(404, "not_found", "没有这个接口。");
  if (request.method !== "POST") return fail(405, "method", "请用 POST 请求。");

  // 1) 读请求
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, "too_large", "请求太大。");
  let body: { serial?: unknown; device?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "bad_request", "请求格式不对。");
  }
  const serial = typeof body.serial === "string" ? normalizeSerial(body.serial) : null;
  const deviceCode = typeof body.device === "string" ? body.device.trim() : "";
  if (!serial) return fail(400, "serial_format", "序列号格式不对，应是 16 位字母数字（如 K7M2-9QXR-4TNB-W3HC），请核对后再试。");
  let devicePub: Uint8Array;
  try {
    devicePub = parseDeviceCode(deviceCode);
  } catch {
    return fail(400, "device_format", "设备码不对，请刷新页面后重试。");
  }

  // 2) 限流：同一来源短时间内输错太多次就先停一下，防止有人批量猜序列号
  const ipHash = (await sha256hex(`phemor-ip|${request.headers.get("CF-Connecting-IP") ?? "local"}`)).slice(0, 24);
  const recent = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE ip = ?1 AND ts > ?2", ipHash, now - FAIL_WINDOW);
  if ((recent?.n ?? 0) >= FAIL_LIMIT) return fail(429, "rate_limited", "尝试次数太多，请 10 分钟后再试。");
  const miss = async () => {
    await db.run("INSERT INTO attempts (ip, ts) VALUES (?1, ?2)", ipHash, now);
    await db.run("DELETE FROM attempts WHERE ts < ?1", now - 86400);
  };

  // 3) 查序列号
  const hash = await hashSerial(serial);
  const row = await db.first<SerialRow>("SELECT hash, packs, max_devices, revoked FROM serials WHERE hash = ?1", hash);
  if (!row) {
    await miss();
    return fail(404, "unknown_serial", "序列号不对，请核对后再试；如果确认没输错，请联系老师。");
  }
  if (row.revoked) return fail(403, "revoked", "这个序列号已停用，请联系老师。");

  // 4) 先生成这台设备的激活码（设备码不合法会在这里失败，此时还没占名额）
  const device = await sha256hex(devicePub);
  const existing = await db.first<{ lid: string }>("SELECT lid FROM activations WHERE hash = ?1 AND device = ?2", hash, device);
  const lid = existing?.lid ?? "S" + hex(crypto.getRandomValues(new Uint8Array(6)));
  const packIds = JSON.parse(row.packs) as string[];
  let code: string;
  try {
    code = await issueLicense({
      signKey: await importSigningKey(JSON.parse(cfg.issuerPrivateJwk) as JsonWebKey),
      master: Uint8Array.from((cfg.masterHex.trim().match(/../g) ?? []).map((h) => parseInt(h, 16))),
      lid,
      cust: "",
      packs: packIds.map((id) => ({ id, kv: cfg.packKv })),
      days: null,
      deviceCode,
      now: now * 1000,
    });
  } catch {
    return fail(400, "device_format", "设备码不对，请刷新页面后重试。");
  }

  // 5) 占名额：一条语句里「数一数、没满才写入」，同时来多个请求也不会超
  if (!existing) {
    const r = await db.run(
      "INSERT INTO activations (hash, device, lid, ts) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM activations WHERE hash = ?1) < ?5",
      hash,
      device,
      lid,
      now,
      row.max_devices,
    );
    if (r.changes === 0)
      return fail(409, "limit", `这个序列号已在 ${row.max_devices} 台设备上激活，名额已满。需要换设备请联系老师。`, { max: row.max_devices });
  }
  const used = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM activations WHERE hash = ?1", hash))?.n ?? 0;
  return reply(200, { ok: true, code, packs: packIds, used, max: row.max_devices, remaining: Math.max(0, row.max_devices - used) });
}
