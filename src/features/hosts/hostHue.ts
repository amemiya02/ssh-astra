import type { HostId } from "@/lib/ipc/hosts";

/** The theme's ANSI hues a Host's monogram can take (`--ansi-*` tokens, so every theme recolours them). */
export const hostHues = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
export type HostHue = (typeof hostHues)[number];

/** The Host's own colour: a stable hash of its id, so it never changes between runs or renames. */
export function hostHue(id: HostId): HostHue {
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hostHues[(hash >>> 0) % hostHues.length]!;
}

/** Full class names (Tailwind only sees literals) for each way a hue is painted. */
export const hueClasses: Record<HostHue, { tile: string; dot: string; line: string }> = {
  red: { tile: "bg-ansi-red/15 text-ansi-red", dot: "bg-ansi-red", line: "bg-ansi-red" },
  green: { tile: "bg-ansi-green/15 text-ansi-green", dot: "bg-ansi-green", line: "bg-ansi-green" },
  yellow: { tile: "bg-ansi-yellow/15 text-ansi-yellow", dot: "bg-ansi-yellow", line: "bg-ansi-yellow" },
  blue: { tile: "bg-ansi-blue/15 text-ansi-blue", dot: "bg-ansi-blue", line: "bg-ansi-blue" },
  magenta: { tile: "bg-ansi-magenta/15 text-ansi-magenta", dot: "bg-ansi-magenta", line: "bg-ansi-magenta" },
  cyan: { tile: "bg-ansi-cyan/15 text-ansi-cyan", dot: "bg-ansi-cyan", line: "bg-ansi-cyan" },
};

/** Up to two initials of a Host name: `web-01` is `W0`, `nas` is `N`. */
export function monogram(name: string): string {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}
