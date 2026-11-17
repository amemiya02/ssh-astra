import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group (usually the setting's label). */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange(value: T): void;
  className?: string;
}

/**
 * An exclusive choice between a few short options (DESIGN.md "Segmented control"):
 * a radio group, arrow keys move and select, Home and End jump to the ends.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.value === value);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let next: SegmentedOption<T> | undefined;
    if (step !== undefined) next = options[(index + step + options.length) % options.length];
    if (event.key === "Home") next = options[0];
    if (event.key === "End") next = options.at(-1);
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    groupRef.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className={cn("bg-muted inline-flex gap-0.5 rounded-md p-0.5", className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            tabIndex={checked ? 0 : -1}
            className={cn(
              "focus-visible:ring-ring/50 h-6.5 rounded-sm px-2.5 text-xs outline-none transition-colors focus-visible:ring-[3px]",
              checked ? "bg-surface text-foreground shadow-panel" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
