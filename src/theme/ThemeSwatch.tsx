import { cn } from "@/lib/utils";
import type { AppTheme } from "./themes";

/** A small chip of a theme: its ground with the accent and a Terminal hue on it. Decorative; the name beside it labels it. */
export function ThemeSwatch({ theme, className }: { theme: AppTheme; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-block size-4 shrink-0 overflow-hidden rounded-[5px] border", className)}
      style={{ backgroundColor: theme.ui.ground, borderColor: theme.ui.border }}
    >
      <span className="absolute inset-y-0 left-0 w-1/3" style={{ backgroundColor: theme.ui.sidebar }} />
      <span className="absolute right-[2px] bottom-[2px] size-1.5 rounded-full" style={{ backgroundColor: theme.ui.primary }} />
      <span className="absolute top-[2px] right-[2px] size-1 rounded-full" style={{ backgroundColor: theme.terminal.green }} />
    </span>
  );
}
