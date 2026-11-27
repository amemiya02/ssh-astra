import type { ReactNode } from "react";
import type { Host } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { hostHue, hueClasses, monogram } from "./hostHue";

const sizes = {
  /** In lists and menus. */
  sm: "size-5 rounded-md text-[11px] tracking-tight",
  /** On Home's cards. */
  md: "size-8 rounded-md text-xs",
};

/** The Host's tile: its initials in its hue, wherever a Host appears. Children sit on the tile (a state dot). */
export function HostMonogram({
  host,
  size = "sm",
  className,
  children,
}: {
  host: Pick<Host, "id" | "name">;
  size?: keyof typeof sizes;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center leading-none font-semibold",
        sizes[size],
        hueClasses[hostHue(host.id)].tile,
        className,
      )}
    >
      {monogram(host.name)}
      {children}
    </span>
  );
}
