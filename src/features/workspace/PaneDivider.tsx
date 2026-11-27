import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { PositionedDivider, SplitResize } from "./pane-layout";

interface Drag {
  pointerId: number;
  start: number;
  fraction: number;
  span: number;
}

function limitFraction(value: number, current: number, span: number): number {
  // Leave room for narrow layouts to resize while keeping both panes usable.
  const min = Math.min(120 / span, 0.4);
  return Math.max(Math.min(min, current), Math.min(value, Math.max(1 - min, current)));
}

export function PaneDivider({ divider, onPreview, onResize }: {
  divider: PositionedDivider;
  onPreview(fraction: number | null): void;
  onResize(resize: SplitResize): void;
}) {
  const { t } = useTranslation();
  const dragRef = useRef<Drag | null>(null);
  const { after, bounds, fraction, path } = divider;
  const horizontal = divider.orientation === "horizontal";
  const position = (event: PointerEvent) => horizontal ? event.clientX : event.clientY;
  const resize = (fraction: number): SplitResize => ({ path, after, fraction });
  const pixelSpan = (element: HTMLElement) => {
    const rect = element.parentElement!.getBoundingClientRect();
    return (horizontal ? rect.width : rect.height) * divider.span;
  };

  function pointerFraction(event: PointerEvent, drag: Drag): number {
    const next = drag.fraction + (position(event) - drag.start) / drag.span;
    return limitFraction(next, drag.fraction, drag.span);
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || dragRef.current) return;
    const span = pixelSpan(event.currentTarget);
    if (span === 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, start: position(event), fraction, span };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) onPreview(pointerFraction(event, drag));
  }

  function stop(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    onPreview(null);
    if (event.type === "pointerup") onResize(resize(pointerFraction(event, drag)));
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (dragRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 0.1 : 0.05;
    let next: number;
    switch (event.key) {
      case "Home": next = 0; break;
      case "End": next = 1; break;
      case horizontal ? "ArrowLeft" : "ArrowUp": next = fraction - step; break;
      case horizontal ? "ArrowRight" : "ArrowDown": next = fraction + step; break;
      default: return;
    }
    event.preventDefault();
    onResize(resize(limitFraction(next, fraction, pixelSpan(event.currentTarget))));
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={t("tabs.resizePanes")}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-controls={divider.paneIds.map((id) => `pane-${id}`).join(" ")}
      aria-valuenow={Math.round(fraction * 100)}
      className={cn(
        "bg-border hover:bg-ring focus-visible:bg-ring absolute z-20 touch-none outline-none after:absolute",
        horizontal
          ? "w-px -translate-x-1/2 cursor-col-resize after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2"
          : "h-px -translate-y-1/2 cursor-row-resize after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2",
      )}
      style={{
        left: `${bounds.left * 100}%`,
        top: `${bounds.top * 100}%`,
        width: horizontal ? undefined : `${bounds.width * 100}%`,
        height: horizontal ? `${bounds.height * 100}%` : undefined,
      }}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={keyDown}
    />
  );
}
