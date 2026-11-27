import type { IBuffer, IMarker, ITheme, Terminal } from "@xterm/xterm";
import { requestHighlightMatches } from "./terminal-highlight-jobs";
import {
  builtInHighlightRules,
  compileHighlightRules,
  isHighlightableLine,
  matchHighlightLines,
  maxHighlightLineLength,
  type HighlightMatch,
  type HighlightRule,
  type TerminalHighlighting,
} from "./terminal-highlighting";

interface LinePart {
  row: number;
  start: number;
  end: number;
}

interface VisibleLine {
  text: string;
  parts: LinePart[];
}

interface PaintedRow extends Omit<LinePart, "row"> {
  marker: IMarker;
  matches: HighlightMatch[];
}

const maxScanColumns = 2 * maxHighlightLineLength + 1;
const maxBatchSize = 32;

/** Read only the visible logical lines, including the short wrapped continuations at the edges. */
function visibleLines(buffer: IBuffer, rows: number, cols: number): VisibleLine[] {
  const top = buffer.viewportY;
  const limit = Math.min(buffer.length, top + rows);
  // A wrapping row contains at least ceil((cols - 1) / 2) characters.
  const earliest = Math.max(0, top - Math.ceil(maxScanColumns / Math.max(1, cols - 1)));
  let row = top;
  while (row > earliest && buffer.getLine(row)?.isWrapped) row--;
  if (buffer.getLine(row)?.isWrapped) {
    // The first visible line is overlong or its beginning has been trimmed from scrollback.
    row = top + 1;
    while (row < limit && buffer.getLine(row)?.isWrapped) row++;
  }

  const lines: VisibleLine[] = [];
  while (row < limit) {
    let text = "";
    const parts: LinePart[] = [];
    let line = buffer.getLine(row);
    if (!line) break;
    while (line) {
      const next = buffer.getLine(row + 1);
      const wraps = next?.isWrapped === true;
      let columns = Math.min(cols, line.length);
      if (wraps && columns <= maxScanColumns && next.getCell(0)?.getWidth() === 2) {
        const lastCell = line.getCell(columns - 1);
        // xterm leaves an empty cell if a wide glyph has to wrap to the next row.
        if (lastCell?.getCode() === 0 && lastCell.getWidth() === 1) columns--;
      }
      const start = text.length;
      text += line.translateToString(!wraps, 0, Math.min(columns, maxScanColumns));
      if (row >= top && row < limit) parts.push({ row, start, end: text.length });
      row++;
      if (text.length >= maxScanColumns) {
        while (row < limit && buffer.getLine(row)?.isWrapped) row++;
        break;
      }
      if (!wraps) {
        if (text && isHighlightableLine(text)) lines.push({ text, parts });
        break;
      }
      line = next;
    }
  }
  return lines;
}

function decorateRow(
  xterm: Terminal, buffer: IBuffer, part: LinePart, matches: HighlightMatch[], palette: ITheme,
): PaintedRow | undefined {
  const { row, start, end } = part;
  const rowMatches = matches.filter((match) => match.start < end && match.end > start);
  const line = rowMatches.length ? buffer.getLine(row) : undefined;
  if (!line) return;

  // A matched character can occupy two cells, and one cell can hold multiple code units.
  const columns: number[] = [];
  const widths: number[] = [];
  const cell = buffer.getNullCell();
  for (let col = 0; col < xterm.cols && columns.length < end - start;) {
    if (!line.getCell(col, cell)) break;
    const width = cell.getWidth() || 1;
    widths[col] = width;
    const length = cell.getChars().length || 1;
    for (let i = 0; i < length; i++) columns.push(col);
    col += width;
  }

  const marker = xterm.registerMarker(row - buffer.baseY - buffer.cursorY);
  for (const match of rowMatches) {
    const x = columns[Math.max(0, match.start - start)];
    const last = columns[Math.min(end, match.end) - start - 1];
    const foregroundColor = palette[match.hue];
    if (x === undefined || last === undefined || !foregroundColor) continue;
    xterm.registerDecoration({ marker, x, width: last + widths[last]! - x, foregroundColor });
  }
  return { start, end, marker, matches };
}

export function attachTerminalHighlighting(xterm: Terminal, config: TerminalHighlighting, palette: ITheme): () => void {
  const builtIn = config.builtIn ? builtInHighlightRules : [];
  const customText = config.rules.filter((rule) => rule.enabled && rule.pattern && rule.kind === "text");
  const plainMatchers = compileHighlightRules([...builtIn, ...customText]);
  const customRules = config.rules.filter((rule) => rule.enabled && rule.pattern);
  if (!builtIn.length && !customRules.length) return () => undefined;

  let regexAvailable = customRules.some((rule) => rule.kind === "regex");
  const skippedRules = new Set<HighlightRule>();
  const cache = new Map<string, HighlightMatch[]>();
  let painted: PaintedRow[] = [];
  let cancelBatch: (() => void) | undefined;
  let frame: number | undefined;

  function clearPaint() {
    for (const { marker } of painted) marker.dispose();
    painted = [];
  }

  function schedule() {
    if (frame === undefined) frame = requestAnimationFrame(refresh);
  }

  function refresh() {
    frame = undefined;
    const buffer = xterm.buffer.active;
    if (buffer.type !== "normal") return;
    const lines = visibleLines(buffer, xterm.rows, xterm.cols);
    const texts = new Set(lines.map(({ text }) => text));
    for (const text of cache.keys()) {
      if (!texts.has(text)) cache.delete(text);
    }

    const pending = [...texts].filter((text) => !cache.has(text));
    const workerRules = customRules.filter((rule) => !skippedRules.has(rule));
    if (regexAvailable && workerRules.some((rule) => rule.kind === "regex")) {
      if (pending.length && !cancelBatch) {
        const batch = pending.slice(0, maxBatchSize);
        const rules = [...builtIn, ...workerRules];
        cancelBatch = requestHighlightMatches({ lines: batch, rules }, (result) => {
          cancelBatch = undefined;
          if ("matches" in result) {
            for (const [index, text] of batch.entries()) cache.set(text, result.matches[index]!);
          } else {
            if ("unavailable" in result) regexAvailable = false;
            else skippedRules.add(rules[result.timedOut]!);
            // Recompute visible lines with the remaining rules and their original precedence.
            cache.clear();
          }
          schedule();
        });
      }
    } else {
      const matches = matchHighlightLines(pending, plainMatchers);
      for (const [index, text] of pending.entries()) cache.set(text, matches[index]!);
    }

    const existing = new Map(painted.filter(({ marker }) => !marker.isDisposed).map((entry) => [entry.marker.line, entry]));
    painted = [];
    for (const { text, parts } of lines) {
      const matches = cache.get(text);
      if (!matches?.length) continue;
      for (const part of parts) {
        const old = existing.get(part.row);
        existing.delete(part.row);
        if (old?.matches === matches && old.start === part.start && old.end === part.end) {
          painted.push(old);
        } else {
          old?.marker.dispose();
          const next = decorateRow(xterm, buffer, part, matches, palette);
          if (next) painted.push(next);
        }
      }
    }
    for (const { marker } of existing.values()) marker.dispose();
  }

  const subscriptions = [
    xterm.onWriteParsed(schedule),
    xterm.onScroll(schedule),
    xterm.onResize(() => {
      clearPaint();
      schedule();
    }),
    xterm.buffer.onBufferChange((buffer) => {
      if (buffer.type === "normal") {
        schedule();
      } else {
        clearPaint();
        cache.clear();
        cancelBatch?.();
        cancelBatch = undefined;
      }
    }),
  ];
  schedule();
  return () => {
    subscriptions.forEach((subscription) => subscription.dispose());
    if (frame !== undefined) cancelAnimationFrame(frame);
    cancelBatch?.();
    clearPaint();
  };
}
