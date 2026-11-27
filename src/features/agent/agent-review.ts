import { createStore } from "zustand/vanilla";
import { notifySystem } from "@/features/notifications/system-notifications";
import { showToast } from "@/features/toasts/toastStore";
import { answerAgentReview, type AgentReviewChoice, type AgentReviewRequest } from "@/lib/ipc/agent-review";
import { requestDesktopAttention } from "@/lib/ipc/notifications";
import { getSetting } from "@/lib/storage";
import { agentAccessSetting } from "./agent-access";

interface PendingReview {
  request: AgentReviewRequest;
  paneId: string;
  eligible(): boolean;
}

export const agentReview = createStore<PendingReview | null>(() => null);

export function openAgentReview(review: PendingReview) {
  if (agentReview.getState() || !getSetting(agentAccessSetting).enabled || !review.eligible()) {
    void answerAgentReview(review.request.id, "unavailable").catch(() => undefined);
    return;
  }
  agentReview.setState(review, true);
  if (!document.hasFocus()) void requestDesktopAttention().catch(() => undefined);
  const file = review.request.kind === "fileWrite";
  notifySystem({ category: "agentReview" }, (t) => ({
    title: file ? t("agentAccess.fileReview.title") : t("agentAccess.review.title"),
    body: file ? t("agentAccess.fileReview.notification") : t("agentAccess.review.notification"),
  }));
}

export function dismissAgentReview(id: number) {
  if (agentReview.getState()?.request.id === id) agentReview.setState(null, true);
}

export function decideAgentReview(review: PendingReview, choice: AgentReviewChoice) {
  if (agentReview.getState() !== review) return;
  dismissAgentReview(review.request.id);
  if ((choice === "copy" || choice === "approve") && (!getSetting(agentAccessSetting).enabled || !review.eligible())) {
    choice = "unavailable";
  }
  void answerAgentReview(review.request.id, choice).then((outcome) => {
    if (choice === "copy") {
      if (outcome === "copied") showToast((t) => t("agentAccess.review.copied"));
      else showToast((t) => t("agentAccess.review.copyFailed"), "error");
    }
    if (choice === "approve") {
      if (outcome === "written") showToast((t) => t("agentAccess.fileReview.written"));
      else if (outcome === "writeUnconfirmed") showToast((t) => t("agentAccess.fileReview.writeUnconfirmed"), "error");
      else showToast((t) => t("agentAccess.fileReview.writeFailed"), "error");
    }
  }, () => {
    if (choice === "copy") showToast((t) => t("agentAccess.review.copyFailed"), "error");
    if (choice === "approve") showToast((t) => t("agentAccess.fileReview.writeFailed"), "error");
  });
}

export function invalidateAgentReview(paneId: string, force = false) {
  const review = agentReview.getState();
  if (review?.paneId === paneId && (force || !review.eligible())) decideAgentReview(review, "unavailable");
}
