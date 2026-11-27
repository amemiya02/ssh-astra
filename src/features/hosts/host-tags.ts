import type { Host } from "@/lib/ipc/hosts";

export const maxHostTags = 10;
export const maxTagLength = 32;

const trimTag = (tag: string): string => tag.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
export const tagKey = (tag: string): string => tag.toLowerCase();

/** A `tag:` query names one complete Tag, which may contain spaces. */
export function explicitTagQuery(query: string): string | undefined {
  const trimmed = query.trim();
  return /^tag:/i.test(trimmed) ? trimTag(trimmed.slice(4)) : undefined;
}

export function hasHostTag(tags: readonly string[] | undefined, tag: string): boolean {
  const key = tagKey(tag);
  return key !== "" && (tags?.some((value) => tagKey(value) === key) ?? false);
}
export function appendHostTag(tags: string[], input: string): string[] {
  if (tags.length >= maxHostTags) return tags;
  const tag = trimTag([...trimTag(input)].slice(0, maxTagLength).join(""));
  return !tag || hasHostTag(tags, tag) ? tags : [...tags, tag];
}

export function hostTagNames(hosts: readonly Host[]): string[] {
  const names = new Map<string, string>();
  for (const host of hosts) {
    for (const tag of host.tags ?? []) {
      const key = tagKey(tag);
      if (!names.has(key)) names.set(key, tag);
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}
