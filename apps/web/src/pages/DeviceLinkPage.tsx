import { localized, type LocalizedMessage } from "../i18n/messages.js";
import { t, useLocale } from "../i18n/index.js";
import { useDevices } from "../features/devices/useDevices.js";
import { SettingsFrame } from "../features/settings/SettingsFrame.js";
import { RecoveryKeyDialog } from "../features/settings/RecoveryKeyDialog.js";
import { Badge, Button, ConfirmDialog, Icon, IconButton, ListItem, Notice, Spinner, TopBar, useToast } from "../ui/index.js";

function DevicesView({ d }: { d: ReturnType<typeof useDevices> }) {
  useLocale();
  const toast = useToast();
  async function announce(action: Promise<boolean>, message: LocalizedMessage) { if (await action) toast.show({ tone: "success", message }); }
  return <>

    <TopBar
      title={t("linkedDevices")}
      onBack={d.goBack}
      backOnPhoneOnly
    />

    <div className="min-h-0 grow overflow-y-auto pb-safe">
      <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">

        {d.error && <Notice tone="danger" action={<Button variant="secondary" onClick={d.retry}>{t("retry")}</Button>}>
          {d.error}
        </Notice>}

        {d.requestsLoading && <Spinner label={t("loadingDeviceRequests")} />}

        {d.pendingRequests.length > 0 && <section className="space-y-3" aria-label={t("deviceLinkRequests")}>
          <h2 className="text-sm font-semibold text-ink-muted">{t("waitingForApproval")}</h2>
          {d.pendingRequests.map((request) => <article
            key={request.id}
            role="status"
            className={`space-y-4 rounded-card border p-4 animate-ui-toast ${request.expired ? "border-line bg-sunken" : "border-brand bg-surface"}`}
          >

            <div className="flex items-start gap-3">
              <Icon name="device-phone" size={24} />
              <div className="min-w-0 grow">
                <h3 className="break-words font-semibold">
                  {request.deviceName}
                </h3>
                <p className="text-sm text-ink-muted">{t("deviceRequestExpires", { status: request.linkMethod === "recovery" ? t("recoveryRequest") : t("wantsToLinkToYourAccount"), time: request.expiresLabel })}</p>
              </div>
              <Badge tone={request.expired ? "neutral" : "brand"}>
                {request.expired ? t("deviceRequestExpiredStatus") : request.status === "pending" ? t("deviceRequestWaitingStatus") : t("deviceRequestApprovedStatus")}
              </Badge>
            </div>

            {request.linkMethod === "approved_link" && request.shortCode && <div className="secret-text flex justify-center gap-4 rounded-control bg-sunken p-4 text-3xl" aria-label={t("approvalCode")}>
              {request.codeChunks.map((chunk, i) => <span key={i}>
                {chunk}
              </span>)}
            </div>}

            <p className="text-sm text-ink-muted">
              {request.linkMethod === "recovery" ? t("thisDeviceIsUsingYourRecoveryKeyNo") : request.status === "approved" ? t("waitingForTheNewDeviceToFinishLinking") : t("approveOnlyIfThisCodeMatchesTheOne")}
            </p>

            {request.linkMethod === "approved_link" && <div className="flex flex-wrap justify-end gap-2">
              {request.expired ? <Button variant="ghost" onClick={() => d.dismissRequest(request.id)}>{t("dismiss")}</Button> : request.status === "pending" ? <>
                <Button
                  variant="secondary"
                  disabled={d.pendingActionId === request.id}
                  onClick={() => void announce(d.handleReject(request.id), localized("deviceLinkRejected"))}
                >{t("reject")}</Button>
                <Button
                  disabled={!d.hasRecoveryKey}
                  loading={d.pendingActionId === request.id}
                  onClick={() => void announce(d.handleApprove(request), localized("deviceApproved"))}
                >{t("approve")}</Button>
              </> : request.status === "approved" ? <Button
                variant="secondary"
                loading={d.pendingActionId === request.id}
                onClick={() => void announce(d.handleCancel(request), localized("deviceLinkCancelled"))}
              >{t("cancel")}</Button> : null}
            </div>}

            {!request.expired && request.linkMethod === "approved_link" && request.status === "pending" && !d.hasRecoveryKey && !d.recoveryLoading && <Notice tone="warning" action={<Button
              variant="secondary"
              loading={d.enrollingRecovery}
              onClick={() => void d.handleEnrollRecoveryKey()}
            >{t("createRecoveryKey")}</Button>}>{t("createARecoveryKeyBeforeApprovingANew")}</Notice>}

          </article>)}
        </section>}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink-muted">{t("yourDevices")}</h2>

          {d.devicesLoading ? <Spinner label={t("loadingDevices")} /> : <ul role="list" className="divide-y divide-line rounded-card border border-line">
            {d.devices.map((device) => <li key={device.id}>
              <ListItem
                leading={<Icon name={device.icon} size={24} />}
                title={device.deviceName}
                subtitle={<span title={device.activityTitle}>{device.activity} · {device.linkedBy}</span>}
                trailing={device.id === d.currentDeviceId ? <Badge>{t("thisDevice")}</Badge> : <IconButton
                  icon="trash"
                  label={t("removeLinkedDeviceNamed", { deviceName: device.deviceName })}
                  variant="danger-ghost"
                  onClick={() => d.handleRemoveDevice(device.id)}
                />}
              />
            </li>)}
          </ul>}

          {!d.devicesLoading && d.devices.filter((device) => device.id !== d.currentDeviceId).length === 0 && <p className="text-sm text-ink-muted">{t("onlyThisDeviceIsLinkedToAddAnother")}</p>}

        </section>

        <Notice title={t("newDevicesReceiveFutureMessagesOnly")} icon="info">{t("earlierHistoryStaysOnTheDevicesThatAlready")}</Notice>

        <ListItem
          leading={<Icon name="key" />}
          title={t("recoveryKey")}
          subtitle={d.hasRecoveryKey ? t("recoveryKeyEnrolledStatus") : t("notSetUp")}
          trailing={<Icon name="chevron-right" size={18} />}
          onClick={() => d.navigate("/settings?section=security", { state: { settingsBack: true } })}
        />

      </div>
    </div>

    <ConfirmDialog
      open={!!d.removalTarget}
      title={t("removeDeviceConfirmTitle", { deviceName: d.removalTarget?.deviceName })}
      description={t("itWillBeSignedOutAndWillNo")}
      confirmLabel={t("removeDevice")}
      tone="danger"
      busy={!!d.removing}
      error={d.removeError}
      onCancel={d.cancelRemoveDevice}
      onConfirm={() => void announce(d.confirmRemoveDevice(), localized("deviceRemoved"))}
    />

    <RecoveryKeyDialog
      recoveryKey={d.generatedRecoveryKey}
      onContinue={d.dismissRecoveryKey}
      onCopy={d.copyRecoveryKey}
      onSave={d.saveRecoveryKey}
      canSave={d.canSaveRecoveryKey}
    />

  </>;
}
export default function DeviceLinkPage() {
  useLocale();
  const devices = useDevices();
  return <SettingsFrame
    title={t("linkedDevices")}
    section="devices"
    detail={<DevicesView d={devices} />}
  />;
}
