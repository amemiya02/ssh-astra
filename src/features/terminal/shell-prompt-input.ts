import type { IMarker, Terminal } from "@xterm/xterm";

/** The editable logical line delimited by the shell's primary prompt. */
export interface ShellPromptInput {
  text: string;
  cursorLine: number;
  cursorColumn: number;
  atEnd: boolean;
  marker: IMarker;
}

const maxInputColumns = 1_024;

/** The cursor in xterm's OSC callback is positioned after the rendered prompt. */
export function trackShellPromptInput(xterm: Terminal) {
  let beforeInputMarker = false;
  let boundary: { marker: IMarker; column: number; prompt: string } | undefined;
  let pendingWrites = 0;
  let previousConnectionWrites = 0;

  const clearBoundary = () => {
    beforeInputMarker = false;
    boundary?.marker.dispose();
    boundary = undefined;
  };
  const osc = xterm.parser.registerOscHandler(6973, (data) => {
    if (previousConnectionWrites > 0) return false;
    if (data === "prompt" || data.startsWith("start;") || data.startsWith("end;")) {
      clearBoundary();
      beforeInputMarker = data === "prompt";
    } else if (data === "input" && beforeInputMarker) {
      beforeInputMarker = false;
      const buffer = xterm.buffer.active;
      const column = buffer.cursorX;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      if (buffer.type === "normal" && column < xterm.cols && line) {
        boundary = { column, marker: xterm.registerMarker(), prompt: line.translateToString(false, 0, column) };
      }
    }
    return false;
  });
  const bufferChange = xterm.buffer.onBufferChange(clearBoundary);
  // Reflow can move the prompt's ending column without emitting a new marker.
  const resize = xterm.onResize(clearBoundary);

  return {
    read(): ShellPromptInput | undefined {
      if (!boundary || pendingWrites > 0 || boundary.marker.isDisposed) return;
      const buffer = xterm.buffer.active;
      const { marker, column, prompt } = boundary;
      const cursorLine = buffer.baseY + buffer.cursorY;
      const cursorColumn = buffer.cursorX;
      if (buffer.type !== "normal" || buffer.viewportY !== buffer.baseY || cursorLine < marker.line || cursorColumn >= xterm.cols) return;
      const first = buffer.getLine(marker.line);
      if (!first || first.translateToString(false, 0, column) !== prompt) return;
      const cell = buffer.getNullCell();
      let columns = 0;
      let text = "";
      for (let row = marker.line; row < buffer.length; row++) {
        const line = row === marker.line ? first : buffer.getLine(row);
        if (!line) return;
        const start = row === marker.line ? column : 0;
        const continues = buffer.getLine(row + 1)?.isWrapped;
        let end = Math.min(xterm.cols, line.length);
        if (!continues) {
          // Only renderer-confirmed soft wraps belong to the same input line.
          if (row < cursorLine) return;
          while (end > start && !line.getCell(end - 1, cell)?.getChars() && cell.getWidth() !== 0) end--;
        }
        columns += end - start;
        if (end < start || columns > maxInputColumns || (row === cursorLine && (cursorColumn < start || cursorColumn > end))) return;
        for (let i = start; i < end; i++) {
          const next = line.getCell(i, cell);
          if (!next || (!next.getChars() && next.getWidth() !== 0)) return;
        }
        text += line.translateToString(false, start, end);
        if (!continues) return { text, cursorLine, cursorColumn, atEnd: cursorLine === row && cursorColumn === end, marker };
      }
    },
    // The transport can enqueue more output before xterm has moved its cursor.
    beforeWrite() { pendingWrites++; },
    afterWrite() {
      pendingWrites--;
      previousConnectionWrites = Math.max(0, previousConnectionWrites - 1);
    },
    reset() {
      clearBoundary();
      previousConnectionWrites = pendingWrites;
    },
    dispose() {
      clearBoundary();
      osc.dispose();
      bufferChange.dispose();
      resize.dispose();
    },
  };
}
