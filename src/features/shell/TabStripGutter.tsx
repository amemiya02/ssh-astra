import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { clampTabStripWidth, maxTabStripWidth, minTabStripWidth } from "@/features/workspace/workspace-prefs";

const gutterWidth = 6;
const workspaceMinWidth = 200;
export const verticalTabsMinMainWidth = minTabStripWidth + gutterWidth + workspaceMinWidth;

interface Drag {
  pointerId: number;
  start: number;
  width: number;
  max: number;
}

export function TabStripGutter({ width, onPreview, onResize, tabListId }: {
  width: number;
  onPreview(width: number | null): void;
  onResize(width: number): void;
  tabListId: string;
}) {
  const { t } = useTranslation();
  const dragRef = useRef<Drag | null>(null);

  function measure(gutter: HTMLElement) {
    const column = gutter.parentElement!;
    const mainWidth = column.parentElement!.getBoundingClientRect().width - 12;
    return {
      width: Math.round(gutter.getBoundingClientRect().left - column.getBoundingClientRect().left),
      max: Math.min(maxTabStripWidth, mainWidth - workspaceMinWidth - gutterWidth),
    };
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, start: event.clientX, ...measure(event.currentTarget) };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    onPreview(clampTabStripWidth(drag.width + event.clientX - drag.start, drag.max));
  }

  function stop(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    onPreview(null);
    if (event.type === "pointerup") {
      const next = clampTabStripWidth(drag.width + event.clientX - drag.start, drag.max);
      if (next !== drag.width) onResize(next);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (dragRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const measured = measure(event.currentTarget);
    const step = event.shiftKey ? 32 : 8;
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = measured.width - step; break;
      case "ArrowRight": next = measured.width + step; break;
      case "Home": next = minTabStripWidth; break;
      case "End": next = measured.max; break;
      default: return;
    }
    event.preventDefault();
    next = clampTabStripWidth(next, measured.max);
    if (next !== measured.width) onResize(next);
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={t("tabs.resizeTabStrip")}
      aria-orientation="vertical"
      aria-controls={tabListId}
      aria-valuemin={minTabStripWidth}
      aria-valuemax={maxTabStripWidth}
      aria-valuenow={width}
      className="group/tab-gutter absolute inset-y-0 right-0 z-10 grid w-1.5 cursor-col-resize touch-none place-items-center outline-none"
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={keyDown}
    >
      <span aria-hidden className="bg-border group-hover/tab-gutter:bg-muted-foreground/40 group-focus-visible/tab-gutter:bg-ring h-7 w-0.5 rounded-full transition-colors" />
    </div>
  );
}
