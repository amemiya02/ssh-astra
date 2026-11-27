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

/** Why a file operation failed, for the control that submitted it. */
export function operationErrorText(t: TFunction, error: CommandError): string {
  const path = String(error.details?.path ?? "");
  switch (error.kind) {
    case "notFound":
      return t("files.operationErrors.notFound", { path });
    case "permissionDenied":
      return t("files.operationErrors.permissionDenied", { path });
    case "ownershipUnavailable":
      return t("files.operationErrors.ownershipUnavailable", { path });
    case "invalidName":
      return t("sftp.invalidName");
    case "alreadyExists":
      return t("files.operationErrors.alreadyExists", { path });
    case "moveIntoSelf":
      return t("files.operationErrors.moveIntoSelf");
    case "notConnected":
    case "notOpen":
      return t("files.operationErrors.notOpen");
    case "timedOut":
      return t("files.errors.timedOut");
    default:
      return t("files.operationErrors.other", { message: error.message });
  }
}
