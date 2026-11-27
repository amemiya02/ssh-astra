import type { Host } from "@/lib/ipc/hosts";
import { ansiHues, type AnsiHue } from "@/theme/monogram-ink";

/** A Host uses its selected ANSI hue or a stable hash of its id. */
export function hostHue({ id, color }: Pick<Host, "id" | "color">): AnsiHue {
  if (color) return color;
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ansiHues[(hash >>> 0) % ansiHues.length]!;
}

/** Full class names (Tailwind only sees literals) for each way a hue is painted. */
export const hueClasses: Record<AnsiHue, { tile: string; dot: string; line: string }> = {
  red: { tile: "bg-ansi-red/15 text-ansi-red-ink", dot: "bg-ansi-red", line: "bg-ansi-red" },
  green: { tile: "bg-ansi-green/15 text-ansi-green-ink", dot: "bg-ansi-green", line: "bg-ansi-green" },
  yellow: { tile: "bg-ansi-yellow/15 text-ansi-yellow-ink", dot: "bg-ansi-yellow", line: "bg-ansi-yellow" },
  blue: { tile: "bg-ansi-blue/15 text-ansi-blue-ink", dot: "bg-ansi-blue", line: "bg-ansi-blue" },
  magenta: { tile: "bg-ansi-magenta/15 text-ansi-magenta-ink", dot: "bg-ansi-magenta", line: "bg-ansi-magenta" },
  cyan: { tile: "bg-ansi-cyan/15 text-ansi-cyan-ink", dot: "bg-ansi-cyan", line: "bg-ansi-cyan" },
};

/**
 * Up to two initials of a Host name: `nas` is `N`, `api-staging` is `AS`. A name ending in a
 * number keeps its last two digits, without leading zeros, so siblings differ and no zero reads
 * as an O: `web-01` is `W1`, `web-02` is `W2`, `db-12` is `D12`.
 */
export function monogram(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.[0]?.toUpperCase();
  const last = parts.at(-1);
  if (parts.length > 1 && first && last && /^\d+$/.test(last)) {
    const number = String(Number(last.slice(-2)));
    return `${first}${number}`;
  }
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}
