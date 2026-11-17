import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CommandError } from "@/lib/ipc/connect";

/**
 * Why a connect failed. A changed host key gets a prominent red warning and,
 * deliberately, no way to replace the recorded key from here.
 */
export function ConnectErrorPanel({ error }: { error: CommandError }) {
  const { t } = useTranslation();
  // Set when a Jump host on the way failed rather than the Host itself.
  const jumpHost = error.details?.jumpHost;
  const hop = jumpHost === undefined ? null : <p className="font-medium">{t("connect.atJumpHost", { name: jumpHost })}</p>;

  if (error.kind === "hostKeyMismatch" && error.details) {
    const d = error.details;
    return (
      <div role="alert" className="border-destructive bg-destructive/10 m-4 rounded-lg border-2 p-4 text-sm">
        <h2 className="text-destructive flex items-center gap-2 text-base font-semibold">
          <TriangleAlert className="size-5" aria-hidden />
          {t("connect.mismatch.title")}
        </h2>
        {hop}
        <p className="mt-2">{t("connect.mismatch.body", { host: d.host })}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t("connect.mismatch.presented")}</dt>
          <dd className="font-mono break-all">{d.fingerprint}</dd>
          <dt className="text-muted-foreground">{t("connect.mismatch.recorded")}</dt>
          <dd className="font-mono break-all">{d.knownFingerprint}</dd>
        </dl>
        <p className="text-muted-foreground mt-3">
          {t("connect.mismatch.fix", { path: d.knownHostsPath, line: d.line })}
        </p>
      </div>
    );
  }

  const known = ["unreachable", "timedOut", "hostKeyDeclined", "hostKeyRevoked", "authenticationFailed", "cancelled"] as const;
  const kind = known.find((k) => k === error.kind);
  return (
    <div role="alert" className="text-destructive m-4 rounded-lg border p-4 text-sm">
      {hop}
      <p className="font-medium">{kind ? t(`connect.errors.${kind}`) : t("connect.errors.generic")}</p>
      <p className="text-muted-foreground mt-1">{error.message}</p>
    </div>
  );
}
