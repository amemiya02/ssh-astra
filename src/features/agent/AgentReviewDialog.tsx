import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSetting } from "@/lib/storage";
import { terminalSetting } from "@/features/terminal/terminal-prefs";
import { agentAccessSetting } from "./agent-access";
import { answerCommandReview, commandReview } from "./command-review";

export function AgentReviewDialog() {
  const { t } = useTranslation();
  const reject = useRef<HTMLButtonElement>(null);
  const review = useStore(commandReview);
  const [{ enabled }] = useSetting(agentAccessSetting);
  const [{ shellIntegration }] = useSetting(terminalSetting);
  useEffect(() => {
    if (review && (!enabled || !shellIntegration)) answerCommandReview(review, "unavailable");
  }, [enabled, review, shellIntegration]);
  if (!review || !enabled || !shellIntegration) return null;
  const { request } = review;
  const decline = () => answerCommandReview(review, "reject");
  return (
    <Dialog key={request.id} open onOpenChange={(open) => !open && decline()}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100vh-2rem)] overflow-y-auto" onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (document.hasFocus()) reject.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>{t("agentAccess.review.title")}</DialogTitle>
          <DialogDescription>{t("agentAccess.review.description")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("agentAccess.review.host")}</dt>
          <dd className="break-all"><bdi>{request.host}</bdi></dd>
          <dt className="text-muted-foreground">{t("agentAccess.review.terminal")}</dt>
          <dd>{t("agentAccess.review.terminalId", { id: request.terminalId })}</dd>
        </dl>
        <pre dir="ltr" className="bg-surface text-foreground max-h-[35vh] overflow-auto rounded-md border p-3 text-sm wrap-anywhere whitespace-break-spaces">
          <code>{request.command}</code>
        </pre>
        <DialogFooter>
          <Button ref={reject} variant="outline" onClick={decline}>{t("agentAccess.review.reject")}</Button>
          <Button onClick={() => answerCommandReview(review, "copy")}>{t("agentAccess.review.copy")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
