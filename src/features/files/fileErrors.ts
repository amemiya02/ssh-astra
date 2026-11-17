import type { TFunction } from "i18next";
import type { CommandError } from "@/lib/ipc/connect";

/** What went wrong, for the panel. */
export function errorText(
  t: TFunction,
  error: CommandError,
  hostName: string,
): string {
  const path = String(error.details?.path ?? "");
  switch (error.kind) {
    case "notConnected":
      return t("files.errors.notConnected", { host: hostName });
    case "notFound":
      return t("files.errors.notFound", { path });
    case "permissionDenied":
      return t("files.errors.permissionDenied", { path });
    case "notADirectory":
      return t("files.errors.notADirectory", { path });
    case "timedOut":
      return t("files.errors.timedOut");
    default:
      return t("files.errors.other", { message: error.message });
  }
}
