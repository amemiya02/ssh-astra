import { Cloud, Database, Router, Server } from "lucide-react";
import type { ReactNode } from "react";
import type { Host, HostIcon } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { hostHue, hueClasses, monogram } from "./hostHue";
import alpineLinux from "./icons/alpinelinux.svg";
import archLinux from "./icons/archlinux.svg";
import freebsd from "./icons/freebsd.svg";
import linux from "./icons/linux.svg";
import linuxMint from "./icons/linuxmint.svg";
import macos from "./icons/macos.svg";
import nixos from "./icons/nixos.svg";
import ubuntu from "./icons/ubuntu.svg";

const sizes = {
  /** In lists and menus. */
  sm: "size-5 rounded-md text-[11px] tracking-tight",
  /** On Home's cards. */
  md: "size-8 rounded-md text-xs",
};

const glyphs = {
  alpineLinux, archLinux, freebsd, linux, linuxMint, macos, nixos, ubuntu,
  cloud: Cloud, database: Database, router: Router, server: Server,
} satisfies Record<HostIcon, string | typeof Server>;

/** The Host's icon or initials on its hue tile. Children can overlay a state dot. */
export function HostMonogram({
  host,
  detectedIcon,
  size = "sm",
  className,
  children,
}: {
  host: Pick<Host, "id" | "name" | "icon" | "color">;
  /** The OS detection feature can supply this hint when no icon was selected. */
  detectedIcon?: HostIcon;
  size?: keyof typeof sizes;
  className?: string;
  children?: ReactNode;
}) {
  const icon = host.icon ?? detectedIcon;
  const Glyph = icon && glyphs[icon];
  const glyphSize = size === "sm" ? "size-3.5" : "size-[18px]";
  return (
    <span
      aria-hidden
      data-host-icon={icon}
      className={cn(
        "relative grid shrink-0 place-items-center leading-none font-semibold",
        sizes[size],
        hueClasses[hostHue(host)].tile,
        className,
      )}
    >
      {typeof Glyph === "string" ? (
        <span
          className={cn(glyphSize, "bg-current mask-contain mask-center mask-no-repeat")}
          style={{ maskImage: `url("${Glyph}")`, WebkitMaskImage: `url("${Glyph}")` }}
        />
      ) : Glyph ? (
        <Glyph className={cn(glyphSize, "text-current")} />
      ) : monogram(host.name)}
      {children}
    </span>
  );
}
