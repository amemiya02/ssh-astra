import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import type { Broadcast } from "@/features/workspace/broadcast";
import { readCommandError } from "@/lib/ipc/connect";
import type { HostId } from "@/lib/ipc/hosts";
import type { Snippet } from "@/lib/ipc/snippets";
import { SnippetPrompt } from "./SnippetDialogs";
import { visibleOnHost } from "./snippet-library";
import { parseSnippet } from "./snippet-template";

type InputTarget = NonNullable<ReturnType<Broadcast["captureInput"]>>;
type Prompt = { snippet: Snippet; template: ReturnType<typeof parseSnippet>; target: InputTarget };

export function useSnippetRunner({ broadcast, paneId, hostId, reportError, onCloseAutoFocus }: {
  broadcast?: Broadcast;
  paneId?: string;
  hostId?: HostId;
  reportError(message: string | null): void;
  onCloseAutoFocus?(event: Event): void;
}) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const send = useCallback(async (snippet: Snippet, target: InputTarget, text: string) => {
    try {
      if (!visibleOnHost(snippet, hostId) || !(await target.send(text, snippet.sendEnter))) {
        reportError(t("snippets.terminalUnavailable"));
      }
    } catch (error) {
      reportError(t("snippets.sendFailed", { message: readCommandError(error).message }));
    }
  }, [hostId, reportError, t]);

  /** Returns whether a variable dialog will take focus. */
  const run = useCallback((snippet: Snippet): boolean => {
    reportError(null);
    const target = paneId ? broadcast?.captureInput(paneId) : undefined;
    if (!target || !visibleOnHost(snippet, hostId)) {
      reportError(t("snippets.terminalUnavailable"));
      return false;
    }
    const template = parseSnippet(snippet.command);
    if (template.variables.length > 0) {
      setPrompt({ snippet, template, target });
      return true;
    }
    const expanded = template.expand(new Map());
    if ("text" in expanded) void send(snippet, target, expanded.text);
    return false;
  }, [broadcast, hostId, paneId, reportError, send, t]);

  const close = () => setPrompt(null);
  return {
    run,
    dialog: (
      <Dialog open={prompt !== null} onOpenChange={(open) => !open && close()}>
        {prompt && <SnippetPrompt
          snippet={prompt.snippet}
          template={prompt.template}
          onCloseAutoFocus={onCloseAutoFocus}
          onCancel={close}
          onRun={(text) => {
            close();
            void send(prompt.snippet, prompt.target, text);
          }}
        />}
      </Dialog>
    ),
  };
}
