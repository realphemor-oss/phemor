-- 序列号：只存哈希，库泄露也拿不到序列号本身
CREATE TABLE IF NOT EXISTS serials (
  hash TEXT PRIMARY KEY,
  packs TEXT NOT NULL,                  -- JSON：这个序列号能开通的包 id
  max_devices INTEGER NOT NULL DEFAULT 6,
  note TEXT NOT NULL DEFAULT '',        -- 你自己的备注（如订单号、店铺）
  revoked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

-- 每台已激活的设备（同一台设备重复激活只算一条）
CREATE TABLE IF NOT EXISTS activations (
  hash TEXT NOT NULL,
  device TEXT NOT NULL,                 -- 设备公钥的 SHA-256
  lid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (hash, device)
);

-- 输错序列号的记录，用来限流（只留 1 天）
CREATE TABLE IF NOT EXISTS attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_ip ON attempts (ip, ts);
