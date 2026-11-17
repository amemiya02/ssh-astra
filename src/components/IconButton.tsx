import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface IconButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "size"> {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  /** Optional shortcut hint shown after the label in the tooltip. */
  shortcut?: string;
  children: ReactNode;
}

/** A quiet 26px icon button for chrome (tab strip, panel headers, status bar). */
export function IconButton({ label, shortcut, className, children, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className={cn("text-muted-foreground hover:text-foreground size-6.5 [&_svg:not([class*='size-'])]:size-4", className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
        {shortcut && <span className="text-background/60 ml-2">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
