/** Tiny IndexedDB key-value wrapper: installed packs, activation codes and this device's key. */
const DB = "phemor-packs";
const VERSION = 3;
/** files = the pictures and recordings of installed packs (one record per file, keyed by its full address);
 *  meta = small facts the service worker reads, such as whether any pack still lives in the old Cache Storage. */
const STORES = ["packs", "licenses", "device", "files", "meta"] as const;
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
export const idbKeys = (store: StoreName = "packs") => run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys());
export const idbGet = <T>(id: string, store: StoreName = "packs") => run<T | undefined>(store, "readonly", (s) => s.get(id));
export const idbPut = (value: unknown, store: StoreName = "packs") => run(store, "readwrite", (s) => s.put(value));
export const idbDelete = (id: string, store: StoreName = "packs") => run(store, "readwrite", (s) => s.delete(id));

/** A pack file kept in the database: the key is the full address the app asks the network for. */
export interface StoredFile {
  id: string;
  type: string;
  data: Blob;
}

/**
 * Write many files over one connection, a few per transaction. Opening the database once per file would take
 * minutes for a pack with ten thousand files.
 */
export async function idbPutFiles(files: StoredFile[]) {
  if (!files.length) return;
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      const store = tx.objectStore("files");
      for (const f of files) store.put(f);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("本地存储写入失败。"));
      tx.onabort = () => reject(tx.error ?? new Error("本地存储空间不足。"));
    });
  } finally {
    db.close();
  }
}

export async function idbDeleteFiles(ids: string[]) {
  const db = await open();
  try {
    for (let i = 0; i < ids.length; i += 500) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        for (const id of ids.slice(i, i + 500)) store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("本地存储删除失败。"));
        tx.onabort = () => reject(tx.error ?? new Error("本地存储删除失败。"));
      });
    }
  } finally {
    db.close();
  }
}

export const idbCountFiles = () => run<number>("files", "readonly", (s) => s.count());
