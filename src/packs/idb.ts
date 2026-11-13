/** Tiny IndexedDB key-value wrapper: installed packs, activation codes and this device's key. */
const DB = "phemor-packs";
const VERSION = 2;
const STORES = ["packs", "licenses", "device"] as const;
export type StoreName = (typeof STORES)[number];

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("这个浏览器不支持本地存储（IndexedDB）。"));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("无法打开本地存储。"));
  });
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error("本地存储写入失败。"));
      tx.onabort = () => reject(tx.error ?? new Error("本地存储空间不足。"));
    });
  } finally {
    db.close();
  }
}

export const idbAll = <T>(store: StoreName = "packs") => run<T[]>(store, "readonly", (s) => s.getAll());
export const idbGet = <T>(id: string, store: StoreName = "packs") => run<T | undefined>(store, "readonly", (s) => s.get(id));
export const idbPut = (value: unknown, store: StoreName = "packs") => run(store, "readwrite", (s) => s.put(value));
export const idbDelete = (id: string, store: StoreName = "packs") => run(store, "readwrite", (s) => s.delete(id));
