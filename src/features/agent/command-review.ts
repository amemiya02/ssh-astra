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

export const commandReview = createStore<PendingReview | null>(() => null);

export function openCommandReview(review: PendingReview) {
  if (commandReview.getState() || !getSetting(agentAccessSetting).enabled || !review.eligible()) {
    void answerAgentReview(review.request.id, "unavailable").catch(() => undefined);
    return;
  }
  commandReview.setState(review, true);
  if (!document.hasFocus()) void requestDesktopAttention().catch(() => undefined);
  notifySystem({ category: "agentReview" }, (t) => ({
    title: t("agentAccess.review.title"),
    body: t("agentAccess.review.notification"),
  }));
}

export function dismissCommandReview(id: number) {
  if (commandReview.getState()?.request.id === id) commandReview.setState(null, true);
}

export function answerCommandReview(review: PendingReview, choice: AgentReviewChoice) {
  if (commandReview.getState() !== review) return;
  dismissCommandReview(review.request.id);
  if (choice === "copy" && (!getSetting(agentAccessSetting).enabled || !review.eligible())) {
    choice = "unavailable";
  }
  void answerAgentReview(review.request.id, choice).then((outcome) => {
    if (choice !== "copy") return;
    if (outcome === "copied") showToast((t) => t("agentAccess.review.copied"));
    else showToast((t) => t("agentAccess.review.copyFailed"), "error");
  }).catch(() => {
    if (choice === "copy") showToast((t) => t("agentAccess.review.copyFailed"), "error");
  });
}

export function invalidateCommandReview(paneId: string, force = false) {
  const review = commandReview.getState();
  if (review?.paneId === paneId && (force || !review.eligible())) answerCommandReview(review, "unavailable");
}
