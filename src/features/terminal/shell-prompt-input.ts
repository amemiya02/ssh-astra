import type { IMarker, Terminal } from "@xterm/xterm";

/** A single editable screen row delimited by the shell's primary prompt. */
export interface ShellPromptInput {
  text: string;
  cursorColumn: number;
  atEnd: boolean;
  marker: IMarker;
}

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
      const cursorColumn = buffer.cursorX;
      if (buffer.type !== "normal" || buffer.viewportY !== buffer.baseY || marker.line !== buffer.baseY + buffer.cursorY ||
        cursorColumn < column || cursorColumn >= xterm.cols || buffer.getLine(marker.line + 1)?.isWrapped) return;
      const line = buffer.getLine(marker.line);
      if (!line || line.translateToString(false, 0, column) !== prompt) return;
      let end = Math.min(xterm.cols, line.length);
      const cell = buffer.getNullCell();
      while (end > column && !line.getCell(end - 1, cell)?.getChars() && cell.getWidth() !== 0) end--;
      if (cursorColumn > end) return;
      for (let i = column; i < end; i++) {
        const next = line.getCell(i, cell);
        if (!next || (!next.getChars() && next.getWidth() !== 0)) return;
      }
      return { text: line.translateToString(false, column, end), cursorColumn, atEnd: cursorColumn === end, marker };
    },
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
