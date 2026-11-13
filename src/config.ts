/** Public repository; change this in a fork. */
export const REPO_URL = "https://github.com/designfuchen/word-atlas";

/**
 * Where learners download word packs, e.g. a Quark / cloud-drive share folder.
 * Fill in the link (and extraction code) and rebuild; or set VITE_PACK_SHARE_URL / _CODE / _NAME at build time.
 * Left empty, the "download" card is hidden.
 */
export const PACK_SHARE = {
  name: import.meta.env.VITE_PACK_SHARE_NAME || "夸克网盘",
  url: import.meta.env.VITE_PACK_SHARE_URL || "",
  code: import.meta.env.VITE_PACK_SHARE_CODE || "",
};

/** Where the list of downloadable word packs lives, relative to the site (override per deployment). */
export const PACK_CATALOG = `${import.meta.env.BASE_URL}packs/packs.json`;
