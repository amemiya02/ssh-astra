import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CompletionCandidate } from "./command-completion";
import type { CompletionView } from "./terminal-completion";

const panel = "absolute right-2 bottom-2 z-10 w-72 max-w-[calc(100%_-_1rem)] rounded-md border border-border bg-popover px-1.5 py-1 text-popover-foreground shadow-sm";

export function TerminalCompletionList({ view, textarea, accept }: {
  view: CompletionView;
  textarea: HTMLTextAreaElement | undefined;
  accept(candidate: CompletionCandidate): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const selectedRef = useRef<HTMLButtonElement>(null);
  const selectedId = "candidates" in view ? `${id}-${view.selected}` : undefined;
  useEffect(() => {
    if (!textarea || !selectedId) return;
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
    textarea.setAttribute("aria-controls", id);
    textarea.setAttribute("aria-activedescendant", selectedId);
    return () => {
      textarea.removeAttribute("aria-controls");
      textarea.removeAttribute("aria-activedescendant");
    };
  }, [id, selectedId, textarea]);

  if ("status" in view) {
    return <div className={`${panel} text-muted-foreground text-xs`} role="status">{t(`terminal.completion.${view.status}`)}</div>;
  }
  return (
    <div id={id} className={`${panel} max-h-52 overflow-auto`} role="listbox" aria-label={t("terminal.completion.title")}>
      {view.candidates.map((candidate, index) =>
        <button
          key={candidate.label}
          id={`${id}-${index}`}
          ref={index === view.selected ? selectedRef : undefined}
          className="block w-full cursor-pointer truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent aria-selected:bg-selected"
          type="button"
          role="option"
          aria-selected={index === view.selected}
          tabIndex={-1}
          title={candidate.label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => accept(candidate)}
        >
          {candidate.label}
        </button>
      )}
    </div>
  );
}
