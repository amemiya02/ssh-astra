import { CircleAlert, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CommandError } from "@/lib/ipc/connect";

const alertClass =
  "border-destructive/30 bg-destructive/8 dark:bg-destructive/12 m-4 max-w-2xl rounded-lg border px-3.5 py-3";

/**
 * Why a connect failed. A changed host key gets a prominent red warning and,
 * deliberately, no way to replace the recorded key from here.
 */
export function ConnectErrorPanel({ error }: { error: CommandError }) {
  const { t } = useTranslation();
  // Set when a Jump host on the way failed rather than the Host itself.
  const jumpHost = error.details?.jumpHost;
  const hop = jumpHost === undefined ? null : <p className="mt-1.5 font-medium">{t("connect.atJumpHost", { name: jumpHost })}</p>;

  if (error.kind === "hostKeyMismatch" && error.details) {
    const d = error.details;
    return (
      <div role="alert" className={alertClass}>
        <h2 className="text-destructive flex items-center gap-2 font-semibold">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {t("connect.mismatch.title")}
        </h2>
        {hop}
        <p className="mt-1.5">{t("connect.mismatch.body", { host: d.host })}</p>
        <dl className="mt-3 grid gap-2">
          <div className="bg-muted rounded-lg border px-3.5 py-3">
            <dt className="text-muted-foreground text-xs">{t("connect.mismatch.recorded", { line: d.line })}</dt>
            <dd className="mt-1 font-mono break-all">{d.knownFingerprint}</dd>
          </div>
          <div className="bg-muted rounded-lg border px-3.5 py-3">
            <dt className="text-muted-foreground text-xs">{t("connect.mismatch.presented")}</dt>
            <dd className="text-destructive mt-1 font-mono break-all">{d.fingerprint}</dd>
          </div>
        </dl>
        <p className="text-muted-foreground mt-3 text-xs">
          {t("connect.mismatch.fix", { path: d.knownHostsPath, line: d.line })}
        </p>
      </div>
    );
  }

  const known = [
    "unreachable",
    "timedOut",
    "hostKeyDeclined",
    "hostKeyRevoked",
    "authenticationFailed",
    "cancelled",
    "keyUnreadable",
    "keyPassphraseIncorrect",
    "keyRejected",
    "agentKeysRejected",
    "noSupportedMethod",
  ] as const;
  const kind = known.find((k) => k === error.kind);
  // Authentication errors carry `keyPath`, `reason` or `methods` for their copy.
  const details = error.details ?? {};
  return (
    <div role="alert" className={alertClass}>
      <p className="text-destructive flex items-center gap-2 font-semibold">
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        <span className="break-all">{kind ? t(`connect.errors.${kind}`, details) : t("connect.errors.generic")}</span>
      </p>
      {hop}
      <p className="text-muted-foreground mt-1 break-all">{error.message}</p>
    </div>
  );
}
