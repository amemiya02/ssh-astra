import { cn } from "@/lib/utils";
import type { HostConnection } from "./hostConnection";

/** A Connection's state as a dot: success while connected, warning (pulsing) while connecting. Pair it with `tabs.status.<state>` text for assistive tech. */
export function ConnectionDot({ state, className }: { state: HostConnection; className?: string }) {
  return (
    <span
      aria-hidden
      data-connection={state}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "connected" ? "bg-success" : "bg-warning motion-safe:animate-pulse",
        className,
      )}
    />
  );
}
