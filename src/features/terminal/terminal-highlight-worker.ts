import { compileHighlightRules, matchHighlightLines, type HighlightMatch, type HighlightRule } from "./terminal-highlighting";

export interface HighlightRequest {
  lines: string[];
  rules: HighlightRule[];
}

export type HighlightReply = { ruleStarted: number } | { matches: HighlightMatch[][] };

self.addEventListener("message", ({ data }: MessageEvent<HighlightRequest>) => {
  const { lines, rules } = data;
  function* observingRules() {
    for (const matcher of compileHighlightRules(rules)) {
      if (rules[matcher.index]?.kind === "regex") {
        self.postMessage({ ruleStarted: matcher.index } satisfies HighlightReply);
      }
      yield matcher;
    }
  }
  self.postMessage({ matches: matchHighlightLines(lines, observingRules()) } satisfies HighlightReply);
});
