import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";

/**
 * A text field that applies its value when it loses focus or on Enter, so a half-typed
 * value never reaches the app. Escape puts the saved value back.
 */
export function CommitField({
  id,
  label,
  value,
  onCommit,
  ...props
}: { id: string; label: string; value: string; onCommit(value: string): void } & Pick<
  ComponentProps<"input">,
  "type" | "min" | "max" | "step" | "placeholder" | "className" | "inputMode"
>) {
  // What the user is typing; null shows the saved value (also after a commit, which may repair it).
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setDraft(null);
  };

  return (
    <Input
      id={id}
      aria-label={label}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      spellCheck={false}
      autoComplete="off"
      {...props}
    />
  );
}
