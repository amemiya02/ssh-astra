import { ansiHues, type AnsiHue } from "@/theme/monogram-ink";

export interface HighlightRule {
  pattern: string;
  kind: "text" | "regex";
  hue: AnsiHue;
  enabled: boolean;
}

export interface CustomHighlightRule extends HighlightRule {
  id: string;
}

export interface TerminalHighlighting {
  builtIn: boolean;
  rules: CustomHighlightRule[];
}

export interface HighlightMatch {
  /** Offsets into the original string in UTF-16 code units. */
  start: number;
  end: number;
  hue: AnsiHue;
}

export const maxHighlightLineLength = 1_000;
const maxHighlightRules = 50;

const ipOctet = "(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)";

export const builtInHighlightRules: readonly HighlightRule[] = [
  { pattern: "\\berrors?\\b", kind: "regex", hue: "red", enabled: true },
  { pattern: "\\bwarn(?:ings?)?\\b", kind: "regex", hue: "yellow", enabled: true },
  { pattern: "\\bfail(?:ed|ures?)?\\b", kind: "regex", hue: "red", enabled: true },
  { pattern: "\\b(?:succeeded|success(?:ful)?)\\b", kind: "regex", hue: "green", enabled: true },
  { pattern: `\\b(?:${ipOctet}\\.){3}${ipOctet}\\b`, kind: "regex", hue: "cyan", enabled: true },
];

export const maxCustomHighlightRules = maxHighlightRules - builtInHighlightRules.length;
export const defaultTerminalHighlighting: TerminalHighlighting = { builtIn: true, rules: [] };

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightExpression(kind: HighlightRule["kind"], pattern: string): RegExp {
  return new RegExp(kind === "text" ? escapePattern(pattern) : pattern, "giu");
}

export function isValidHighlightPattern(kind: HighlightRule["kind"], pattern: string): boolean {
  if (!pattern) return false;
  try {
    highlightExpression(kind, pattern);
    return true;
  } catch {
    return false;
  }
}

export function normalizeTerminalHighlighting(raw: unknown): TerminalHighlighting {
  if (typeof raw !== "object" || raw === null) return defaultTerminalHighlighting;
  const { builtIn, rules } = raw as Partial<TerminalHighlighting>;
  const ids = new Set<string>();
  const normalized: CustomHighlightRule[] = [];
  for (const rule of Array.isArray(rules) ? rules.slice(0, maxCustomHighlightRules) : []) {
    if (
      !rule || typeof rule.id !== "string" || !rule.id || ids.has(rule.id) ||
      typeof rule.pattern !== "string" || (rule.kind !== "text" && rule.kind !== "regex")
    ) continue;
    ids.add(rule.id);
    normalized.push({
      id: rule.id,
      pattern: rule.pattern,
      kind: rule.kind,
      hue: ansiHues.includes(rule.hue) ? rule.hue : "cyan",
      enabled: rule.enabled === true,
    });
  }
  return { builtIn: typeof builtIn === "boolean" ? builtIn : defaultTerminalHighlighting.builtIn, rules: normalized };
}

export function isHighlightableLine(text: string): boolean {
  return text.length <= maxHighlightLineLength ||
    (text.length <= maxHighlightLineLength * 2 && [...text].length <= maxHighlightLineLength);
}

/** Compiles rules once per configuration. Later rules take priority when matches overlap. */
export function compileHighlightRules(rules: readonly HighlightRule[]) {
  return rules.slice(0, maxHighlightRules).flatMap(({ pattern, hue, kind, enabled }, index) => {
    if (!enabled || !pattern) return [];
    try {
      return [{ index, expression: highlightExpression(kind, pattern), color: ansiHues.indexOf(hue) + 1 }];
    } catch {
      return [];
    }
  });
}

type HighlightMatcher = ReturnType<typeof compileHighlightRules>[number];

export function matchHighlightLines(texts: readonly string[], matchers: Iterable<HighlightMatcher>): HighlightMatch[][] {
  const colors = texts.map((text) => new Uint8Array(isHighlightableLine(text) ? text.length : 0));
  for (const { expression, color } of matchers) {
    for (const [index, text] of texts.entries()) {
      const line = colors[index];
      if (!line?.length) continue;
      for (const match of text.matchAll(expression)) {
        line.fill(color, match.index, match.index + match[0].length);
      }
    }
  }
  return colors.map((line) => {
    const matches: HighlightMatch[] = [];
    for (let start = 0; start < line.length;) {
      const color = line[start]!;
      let end = start + 1;
      while (line[end] === color) end++;
      const hue = ansiHues[color - 1];
      if (hue) matches.push({ start, end, hue });
      start = end;
    }
    return matches;
  });
}
