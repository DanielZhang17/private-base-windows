import { localized } from "../i18n/messages.js";
import { t, useLocale } from "../i18n/index.js";
/**
 * Dev-only gallery of every primitive, served at /ui-gallery.html by `npx vite`.
 * It is not an entry of the production build. Sample data is made up.
 */
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import {
  Disclosure,
  AppShell, Avatar, Badge, BottomBar, Button, ConfirmDialog, CountBadge, Dialog, EmptyState, Field, Icon,
  ICON_NAMES, IconButton, Input, ListItem, NavItem, NavRail, Notice, Sheet, Skeleton, Spinner, Textarea,
  ToastProvider, TopBar, useToast,
} from "./index.js";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[0.75rem] font-semibold uppercase tracking-wider text-ink-subtle">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

function ShellDemo() {
  useLocale();
  const [open, setOpen] = useState<string | null>("Mara Lindqvist");
  const people = ["Mara Lindqvist", t("fieldTeam"), "Tomas Okafor"];
  return (
    <div className="h-[32rem] w-full overflow-hidden rounded-card border border-line [&>div]:h-full">
      <AppShell
        detailActive={open !== null}
        rail={<NavRail footer={<Avatar name="Sam Rivera" size="sm" />}><NavItem icon="chats" label={t("chats")} active count={3} /><NavItem icon="settings" label={t("settings")} /></NavRail>}
        bottomBar={<BottomBar><NavItem icon="chats" label={t("chats")} active count={3} /><NavItem icon="settings" label={t("settings")} /></BottomBar>}
        list={
          <>
            <TopBar title={t("chats")} actions={<IconButton icon="edit" label={t("newConversation")} />} />
            <ul role="list" className="flex flex-col gap-0.5 overflow-y-auto p-2">
              {people.map((name, index) => (
                <li key={name}>
                  <ListItem
                    leading={<Avatar name={name} shape={index === 1 ? "rounded" : "circle"} presence={index === 0 ? "online" : undefined} />}
                    title={name}
                    subtitle={t("seeYouAtTheHarbourAtNine")}
                    meta="09:41"
                    trailing={index === 1 ? <CountBadge count={3} label={t("unreadMessages")} announcement={t("unreadCount", { count: 3 })} /> : undefined}
                    selected={open === name}
                    onClick={() => setOpen(name)}
                  />
                </li>
              ))}
            </ul>
          </>
        }
        placeholder={<EmptyState icon="chats" title={t("noConversationOpen")} description={t("pickAConversationFromTheListOrStart")} />}
        detail={open && (
          <>
            <TopBar
              title={open}
              subtitle={t("verified")}
              onBack={() => setOpen(null)}
              backOnPhoneOnly
              leading={<Avatar name={open} size="sm" />}
              actions={<><IconButton icon="phone" label={t("startVoiceCall")} /><IconButton icon="video" label={t("startVideoCall")} /></>}
            />
            <div className="flex grow flex-col justify-end gap-2 overflow-y-auto p-4">
              <div className="bubble bubble-incoming self-start">{t("areWeStillOnForTomorrow")}</div>
              <div className="bubble bubble-own self-end">{t("yesNineAtTheHarbour")}</div>
              <div className="bubble bubble-own bubble-failed self-end">{t("bringingTheCharts")}</div>
            </div>
          </>
        )}
      />
    </div>
  );
}

function Overlays() {
  useLocale();
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setDialog(true)}>{t("galleryDialogAction")}</Button>
      <Button variant="secondary" onClick={() => setSheet(true)}>{t("gallerySheetAction")}</Button>
      <Button variant="danger" onClick={() => setConfirm(true)}>{t("galleryConfirmDialogAction")}</Button>
      <Button variant="ghost" onClick={() => toast.show({ tone: "success", message: localized("recoveryKeyCopied") })}>{t("galleryToastAction")}</Button>
      <Button variant="ghost" onClick={() => toast.show({ tone: "danger", title: localized("couldNotRemoveMember"), message: localized("checkYourConnectionAndTryAgain"), action: { label: localized("retry"), onClick: () => undefined } })}>{t("errorToast")}</Button>
      <Dialog open={dialog} onClose={() => setDialog(false)} title={t("renameThisDevice")} footer={<><Button variant="secondary" onClick={() => setDialog(false)}>{t("cancel")}</Button><Button onClick={() => setDialog(false)}>{t("saveChangesAction")}</Button></>}>
        <Field label={t("deviceName")} help={t("otherLinkedDevicesSeeThisName")}><Input defaultValue="Sam's laptop" /></Field>
      </Dialog>
      <Sheet open={sheet} onClose={() => setSheet(false)} title={t("attach")}>
        <ul role="list" className="pb-2">
          <li><ListItem leading={<Icon name="image" />} title={t("photoOrVideo")} onClick={() => setSheet(false)} /></li>
          <li><ListItem leading={<Icon name="file" />} title={t("fileTypeLabel")} onClick={() => setSheet(false)} /></li>
        </ul>
      </Sheet>
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title={t("forgetThisDeviceSKeys")}
        description={t("messageHistoryOnThisDeviceWillBeLost")}
        acknowledgeLabel={t("iUnderstandThatThisCannotBeUndone")}
        confirmLabel={t("forgetKeys")}
        onConfirm={() => setConfirm(false)}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

function Gallery() {
  useLocale();
  const [dark, setDark] = useState(false);
  return (
    <ToastProvider>
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-[1.75rem] font-semibold">{t("uiGallery")}</h1>
          <Button
            variant="secondary"
            leadingIcon={dark ? "sun" : "moon"}
            onClick={() => {
              document.documentElement.dataset.theme = dark ? "light" : "dark";
              setDark(!dark);
            }}
          >
            {dark ? t("themeLight") : t("themeDark")}
          </Button>
        </div>
        <Section title={t("buttons")}>
          <Button>{t("galleryPrimaryButton")}</Button><Button variant="secondary">{t("gallerySecondaryButton")}</Button><Button variant="ghost">{t("galleryGhostButton")}</Button>
          <Button variant="danger">{t("galleryDangerButton")}</Button><Button variant="danger-ghost">{t("galleryDangerGhostButton")}</Button>
          <Button loading>{t("saving")}</Button><Button disabled>{t("disabled")}</Button><Button size="sm" leadingIcon="copy">{t("gallerySmallButton")}</Button><Button size="lg" trailingIcon="chevron-right">{t("galleryLargeButton")}</Button>
          <IconButton icon="attach" label={t("attachFile")} /><IconButton icon="send" label={t("sendMessageAction")} variant="primary" /><IconButton icon="phone-off" label={t("endCall")} variant="danger" size="lg" />
          <Button href="/clients" variant="secondary" leadingIcon="download">{t("clients.documentTitle")}</Button>
          <Disclosure summary={t("clients.verifyDownload")} className="w-full border-t border-line">
            <p className="pb-4 text-[0.8125rem] text-ink-muted">{t("clients.verifyResult")}</p>
          </Disclosure>
        </Section>
        <Section title={t("fields")}>
          <div className="grid w-full gap-4 sm:grid-cols-2">
            <Field label={t("username")} help={t("lettersNumbersAndUnderscores")}><Input placeholder={t("sampleUsername")} leading={<Icon name="user" size={18} />} /></Field>
            <Field label={t("password")} error={t("thatPasswordIsNotCorrect")} required><Input type="password" defaultValue="hunter" trailing={<IconButton icon="eye" label={t("showPassword")} size="sm" />} /></Field>
            <Field label={t("galleryAboutField")}><Textarea placeholder={t("aLineAboutYou")} /></Field>
            <Field label={t("disabled")}><Input disabled defaultValue={t("cannotEdit")} /></Field>
          </div>
        </Section>
        <Section title={t("badgesAvatarsLoading")}>
          <Badge>{t("thisDevice")}</Badge><Badge tone="brand">{t("galleryNewBadge")}</Badge><Badge tone="success" icon="shield-check">{t("verified")}</Badge>
          <Badge tone="warning" icon="shield">{t("notVerified")}</Badge><Badge tone="danger" icon="alert-circle">{t("notSent")}</Badge><Badge tone="brand" variant="solid">{t("galleryPendingBadge")}</Badge><CountBadge count={128} label={t("unreadMessages")} announcement={t("unreadCount", { count: 128 })} />
          <Avatar name="Mara Lindqvist" size="xs" /><Avatar name="Tomas Okafor" size="sm" presence="online" /><Avatar name={t("fieldTeam")} shape="rounded" /><Avatar name="Sam Rivera" size="lg" presence="offline" />
          <Spinner /><Skeleton shape="circle" /><Skeleton className="w-40" />
        </Section>
        <Section title={t("notices")}>
          <div className="grid w-full gap-3 sm:grid-cols-2">
            <Notice title={t("newDevicesReceiveFutureMessagesOnly2")}>{t("earlierHistoryStaysOnTheDevicesThatAlready")}</Notice>
            <Notice tone="success">{t("safetyNumberVerified2")}</Notice>
            <Notice tone="warning" title={t("reconnecting")}>{t("messagesWillSendWhenYouAreBackOnline")}</Notice>
            <Notice tone="danger" action={<Button size="sm" variant="secondary">{t("retry")}</Button>}>{t("couldNotLoadDevices")}</Notice>
          </div>
        </Section>
        <Section title={t("overlays")}><Overlays /></Section>
        <Section title={t("appShellResizeTheWindow")}><ShellDemo /></Section>
        <Section title={t("icons", { length: ICON_NAMES.length })}>
          <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2">
            {ICON_NAMES.map((name) => (
              <div key={name} className="flex flex-col items-center gap-1.5 rounded-control border border-line p-3 text-[0.6875rem] text-ink-muted">
                <Icon name={name} size={24} className="text-ink" />
                {name}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
