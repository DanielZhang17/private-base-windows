import { useId } from "react";
import { t } from "../../i18n/index.js";
import { Button, ListItem, Notice, Spinner } from "../../ui/index.js";
import { useGroupJoinRequests } from "./useGroupJoinRequests.js";

export function GroupJoinRequests({ conversationId, joinByName }: { conversationId: string; joinByName: boolean }) {
  const heading = useId();
  const flow = useGroupJoinRequests(conversationId);
  return <section aria-labelledby={heading} className="space-y-2">
    <h3 id={heading} className="text-xs font-semibold text-ink-subtle uppercase">{t("groupJoinRequests")}</h3>
    <label className="flex min-h-11 items-center gap-3 text-sm">
      <input type="checkbox" className="size-5 accent-brand" checked={joinByName} disabled={flow.busy}
        onChange={(event) => flow.update({ joinByName: event.currentTarget.checked })} />
      {t("groupJoinEnable")}
    </label>
    {flow.actionError && <Notice tone="danger">{flow.actionError}</Notice>}
    {flow.loading ? <Spinner />
      : flow.loadError ? <Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void flow.refresh()}>{t("retry")}</Button>}>{flow.loadError}</Notice>
      : flow.queue?.length ? <ul className="space-y-1">
        {flow.queue.map((request) => <li key={request.id} className="rounded-card border border-line p-2">
          <ListItem title={request.displayName} subtitle={`@${request.username}`} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={flow.busy} aria-label={t("groupJoinDeclineNamed", { name: request.displayName })}
              onClick={() => flow.update({ id: request.id, decision: "decline" })}>{t("decline")}</Button>
            <Button size="sm" disabled={flow.busy || !joinByName} aria-label={t("groupJoinApproveNamed", { name: request.displayName })}
              onClick={() => flow.update({ id: request.id, decision: "approve" })}>{t("approve")}</Button>
          </div>
        </li>)}
      </ul> : <p className="text-sm text-ink-muted">{t("groupJoinNone")}</p>}
  </section>;
}
