import type { Entry, IndexRow } from "./types";
import type { Extras } from "../packs/spec";

export interface Merged {
  rows: IndexRow[];
  /** Position of each base word in the original index; entry chunks are addressed by it. */
  baseIndex: Map<string, number>;
  /** Entries shipped by packs; they win over the chunked base entries. */
  overrides: Map<string, Entry>;
  added: number;
}

/**
 * Add the words of installed packs to the base index.
 * A pack word whose id already exists replaces that word in place; a new word is inserted
 * after the last base word of the same or an easier level, so it joins the learning path
 * where it belongs and the order of everything else is untouched.
 */
export function mergeWords(base: IndexRow[], extras: Extras): Merged {
  const baseIndex = new Map(base.map((r, i) => [r[0], i]));
  const overrides = new Map<string, Entry>();
  for (const e of extras.entries) overrides.set(e.id, e);
  const replace = new Map<number, IndexRow>();
  const fresh = new Map<string, IndexRow>();
  for (const r of extras.rows) {
    if (!overrides.has(r[0])) continue;
    const at = baseIndex.get(r[0]);
    if (at !== undefined) replace.set(at, r);
    else fresh.set(r[0], r);
  }
  // lastAtOrBelow[c]: index of the last base row whose level is <= c.
  const levels = Math.max(6, ...base.map((r) => r[4] + 1), ...[...fresh.values()].map((r) => r[4] + 1));
  const lastAtOrBelow: number[] = Array(levels).fill(-1);
  base.forEach((r, i) => {
    for (let c = r[4]; c < levels; c++) if (i > lastAtOrBelow[c]) lastAtOrBelow[c] = i;
  });
  const after = new Map<number, IndexRow[]>();
  for (const r of fresh.values()) {
    const at = lastAtOrBelow[r[4]];
    const list = after.get(at);
    if (list) list.push(r);
    else after.set(at, [r]);
  }
  const rows: IndexRow[] = [...(after.get(-1) ?? [])];
  base.forEach((r, i) => {
    rows.push(replace.get(i) ?? r);
    const more = after.get(i);
    if (more) rows.push(...more);
  });
  return { rows, baseIndex, overrides, added: fresh.size };
}
