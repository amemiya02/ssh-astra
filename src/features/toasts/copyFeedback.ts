import { writeClipboardText } from "@/lib/ipc/system";
import { showToast } from "./toastStore";

export function notifyCopied() {
  showToast((t) => t("toast.copied"));
}

export async function copyTextWithToast(text: string) {
  await writeClipboardText(text);
  notifyCopied();
}
