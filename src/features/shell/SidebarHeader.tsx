import type { ReactNode } from "react";

/**
 * The 34px row at the top of a sidebar view: title left, actions right. It is part of the
 * window's drag region, and on macOS keeps clear of the traffic lights (`--chrome-inset`, set by `AppShell`).
 */
export function SidebarHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-8.5 shrink-0 items-center gap-0.5 pr-1 pl-[calc(0.25rem+var(--chrome-inset,0px))]"
    >
      <h2 data-tauri-drag-region className="flex-1 truncate text-[13px] font-semibold select-none">
        {title}
      </h2>
      {children}
    </div>
  );
}
