import { Fragment, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSetting } from "@/lib/storage";
import { terminalSetting } from "@/features/terminal/terminal-prefs";
import { agentAccessSetting } from "./agent-access";
import { decideAgentReview, agentReview } from "./agent-review";

export function AgentReviewDialog() {
  const { t, i18n } = useTranslation();
  const reject = useRef<HTMLButtonElement>(null);
  const review = useStore(agentReview);
  const [{ enabled }] = useSetting(agentAccessSetting);
  const [{ shellIntegration }] = useSetting(terminalSetting);
  const disabled = !enabled || (review?.request.kind === "command" && !shellIntegration);
  useEffect(() => {
    if (review && disabled) decideAgentReview(review, "unavailable");
  }, [disabled, review]);
  if (!review || disabled) return null;
  const { request } = review;
  const file = request.kind === "fileWrite";
  const decline = () => decideAgentReview(review, "reject");
  return (
    <Dialog key={request.id} open onOpenChange={(open) => !open && decline()}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100vh-2rem)] overflow-y-auto" onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (document.hasFocus()) reject.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>{file ? t("agentAccess.fileReview.title") : t("agentAccess.review.title")}</DialogTitle>
          <DialogDescription>{file ? t("agentAccess.fileReview.description") : t("agentAccess.review.description")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("agentAccess.review.host")}</dt>
          <dd className="break-all"><bdi>{request.host}</bdi></dd>
          <dt className="text-muted-foreground">{t("agentAccess.review.terminal")}</dt>
          <dd>{t("agentAccess.review.terminalId", { id: request.terminalId })}</dd>
          {file && <>
            <dt className="text-muted-foreground">{t("agentAccess.fileReview.size")}</dt>
            <dd>{t("agentAccess.fileReview.bytes", {
              count: request.byteLength,
              bytes: new Intl.NumberFormat(i18n.resolvedLanguage).format(request.byteLength),
            })}</dd>
          </>}
        </dl>
        {file && <p className="text-muted-foreground text-sm">{t("agentAccess.fileReview.path")}</p>}
        <pre dir="ltr" className="bg-surface text-foreground max-h-[35vh] overflow-auto rounded-md border p-3 text-sm wrap-anywhere whitespace-break-spaces">
          <code>{file ? request.path.slice(1).split("/").map((segment, index) => (
            <Fragment key={index}>/<bdi>{segment}</bdi></Fragment>
          )) : request.command}</code>
        </pre>
        <DialogFooter>
          <Button ref={reject} variant="outline" onClick={decline}>{t("agentAccess.review.reject")}</Button>
          <Button onClick={() => decideAgentReview(review, file ? "approve" : "copy")}>
            {file ? t("agentAccess.fileReview.approve") : t("agentAccess.review.copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
