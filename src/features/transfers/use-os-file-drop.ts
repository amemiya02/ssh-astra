import { useEffect, useRef, useState, type RefObject } from "react";
import { onOsFileDrag } from "@/lib/ipc/transfers";

/**
 * Files dragged in from the system's file manager onto `target` (Tauri's native file drop,
 * not @dnd-kit, which is for in-app drags). `over` is true while they hover over it;
 * dropping them there calls `onDrop` with their paths. Disabled, it ignores drags.
 */
export function useOsFileDrop(
  target: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (paths: string[]) => void,
): { over: boolean } {
  const [over, setOver] = useState(false);
  const latest = useRef(onDrop);
  useEffect(() => {
    latest.current = onDrop;
  });

  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    const inside = (x: number, y: number) => {
      const rect = target.current?.getBoundingClientRect();
      return rect !== undefined && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    };
    void onOsFileDrag((drag) => {
      if (drag.type === "leave") return setOver(false);
      const hit = inside(drag.x, drag.y);
      if (drag.type === "over") return setOver(hit);
      setOver(false);
      if (hit && drag.paths.length > 0) latest.current(drag.paths);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
      setOver(false);
    };
  }, [enabled, target]);

  return { over: enabled && over };
}
