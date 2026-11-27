import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { readCommandError } from "@/lib/ipc/connect";
import type { HostImportSource } from "@/lib/ipc/hosts";
import { pickOpenPath } from "@/lib/ipc/system";

interface ImportOption {
  kind: HostImportSource["kind"];
  description?(t: TFunction): string;
  choose(t: TFunction): Promise<HostImportSource | null>;
}

const sources: ImportOption[] = [
  {
    kind: "sshConfig",
    choose: async () => ({ kind: "sshConfig" }),
  },
  fileSource("csv", ["csv"]),
  fileSource("putty", ["reg"]),
  fileSource("mobaxterm", ["mxtsessions", "moba"]),
  folderSource("xshell"),
];

function fileSource(kind: "csv" | "putty" | "mobaxterm", extensions: string[]): ImportOption {
  return {
    kind,
    description: (t) => t(`hosts.import.${kind}.help`),
    async choose(t) {
      const path = await pickOpenPath({
        title: t(`hosts.import.${kind}.chooseFile`),
        filters: [{ name: t(`hosts.import.${kind}.fileType`), extensions }],
      });
      return path ? { kind, path } : null;
    },
  };
}

function folderSource(kind: "xshell"): ImportOption {
  return {
    kind,
    description: (t) => t(`hosts.import.${kind}.help`),
    async choose(t) {
      const path = await pickOpenPath({ title: t(`hosts.import.${kind}.chooseFolder`), directory: true });
      return path ? { kind, path } : null;
    },
  };
}

export function HostImportDialogContent({ onImport, onClose }: {
  onImport(source: HostImportSource): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (option: ImportOption) => {
    setBusy(true);
    setError(null);
    try {
      const source = await option.choose(t);
      if (source) await onImport(source);
    } catch (e) {
      setError(t(`hosts.import.${option.kind}.error`, { message: readCommandError(e).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent
      showCloseButton={false}
      className="max-h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] overflow-y-auto p-5 sm:max-w-120"
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
    >
      <DialogHeader>
        <DialogTitle>{t("hosts.import.pickerTitle")}</DialogTitle>
        <DialogDescription>{t("hosts.import.chooseSource")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3" aria-busy={busy}>
        {sources.map((option) => (
          <div key={option.kind} className="grid gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="justify-start"
              disabled={busy}
              aria-describedby={option.description ? `host-import-${option.kind}-help` : undefined}
              onClick={() => void choose(option)}
            >
              {t(`hosts.import.${option.kind}.action`)}
            </Button>
            {option.description && (
              <p id={`host-import-${option.kind}-help`} className="text-muted-foreground text-xs">
                {option.description(t)}
              </p>
            )}
          </div>
        ))}
      </div>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      <DialogFooter>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
          {t("hosts.cancel")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
