import { fuzzyMatch } from "@/features/hosts/hostTree";
import { explicitTagQuery, hasHostTag } from "@/features/hosts/host-tags";

export type PaletteGroup = "hosts" | "tabs" | "actions";

/** One row the command palette can show, whatever it opens or runs. */
export interface PaletteEntry {
  /** Unique across the palette, e.g. `host:<id>`. */
  id: string;
  group: PaletteGroup;
  title: string;
  /** Searched too, but ranked below the title (a Host's `user@address`). */
  detail?: string;
  /** Other words that should find it ("preferences" for Settings). */
  keywords?: string[];
  /** Hosts only: their Tags, ranked below the existing searchable fields. */
  tags?: readonly string[];
  /** Hosts only: 0 is the most recently opened. */
  recent?: number;
}

export interface RankedEntry<T extends PaletteEntry = PaletteEntry> {
  entry: T;
  id: string;
  /** Indexes of `title` that matched the query, for highlighting. */
  titleMatches: number[];
}

const groupOrder: Record<PaletteGroup, number> = { hosts: 0, tabs: 1, actions: 2 };

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * How well `text` matches `query`, higher is better, or `null`. In tiers: a prefix, then a
 * substring starting a word, then any substring, then the query's letters in order (tighter wins).
 */
function score(text: string, query: string): { score: number; indexes: number[] } | null {
  const indexes = fuzzyMatch(text, query);
  if (!indexes) return null;
  // The query is not blank, so there is at least one index.
  const first = indexes[0] ?? 0;
  const last = indexes.at(-1) ?? 0;
  const contiguous = last - first + 1 === indexes.length;
  let value: number;
  if (contiguous && first === 0) value = 4000;
  else if (contiguous && !isWordChar(text[first - 1])) value = 3000 - first;
  else if (contiguous) value = 2000 - first;
  else value = 1000 - Math.min(999, (last - first + 1 - indexes.length) * 10 + first);
  return { score: value, indexes };
}

const byRecency = (a: PaletteEntry, b: PaletteEntry) => (a.recent ?? Infinity) - (b.recent ?? Infinity);

/**
 * The palette's rows for `query`, best first. With no query: Hosts (recently opened first), then
 * tabs, then actions. With one: only matches, by how well the title (else detail or keywords)
 * matches; equally good Hosts go most recent first.
 */
export function rankPalette<T extends PaletteEntry>(entries: T[], query: string): RankedEntry<T>[] {
  const q = query.trim();
  if (!q) {
    return [...entries]
      .sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || byRecency(a, b))
      .map((entry) => ({ entry, id: entry.id, titleMatches: [] }));
  }

  const tag = explicitTagQuery(q);
  if (tag !== undefined) {
    return entries
      .filter((entry) => entry.group === "hosts" && hasHostTag(entry.tags, tag))
      .sort(byRecency)
      .map((entry) => ({ entry, id: entry.id, titleMatches: [] }));
  }

  const scored = entries.flatMap((entry) => {
    const title = score(entry.title, q);
    if (title) return [{ entry, value: title.score, titleMatches: title.indexes }];
    // Any title match beats any match elsewhere.
    const others = [entry.detail ?? "", ...(entry.keywords ?? [])].map((text) => score(text, q)?.score ?? -Infinity);
    const best = Math.max(...others);
    if (best !== -Infinity) return [{ entry, value: best - 5000, titleMatches: [] }];
    const bestTag = Math.max(...(entry.tags ?? []).map((tag) => score(tag, q)?.score ?? -Infinity));
    return bestTag === -Infinity ? [] : [{ entry, value: bestTag - 10000, titleMatches: [] }];
  });
  return scored
    .sort((a, b) => b.value - a.value || byRecency(a.entry, b.entry))
    .map(({ entry, titleMatches }) => ({ entry, id: entry.id, titleMatches }));
}
