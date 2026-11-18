import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { copyText } from "../../platform/clipboard.js";
import { platformName } from "../../platform/environment.js";
import { Button, DarkSurface, Disclosure, Field, Icon, Notice, Spinner, Textarea, useToast } from "../../ui/index.js";
import { inspectTransferWords, parseTransferPairing, UnsupportedTransferVersion } from "./pairing.js";
import type { HistoryTransferInvitation } from "./useHistoryTransfer.js";

export function TransferWait({ children }: { children: string }) {
  return <p role="status" className="flex items-center gap-3 text-sm text-ink-muted"><Spinner label={null} />{children}</p>;
}

export function TransferHeading({ children, hidden }: { children: string; hidden?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [children]);
  return <h1 ref={ref} tabIndex={-1} className={hidden ? "sr-only" : "rounded-sm text-2xl leading-tight font-bold tracking-tight sm:text-[1.75rem]"}>{children}</h1>;
}

export function TransferTile({ icon, tone = "brand" }: { icon: "camera" | "check-circle" | "alert-circle"; tone?: "brand" | "success" | "danger" }) {
  const color = { brand: "bg-brand-soft text-on-brand-soft", success: "bg-ok-soft text-ok", danger: "bg-danger-soft text-danger" }[tone];
  return <div className={`grid size-14 place-items-center rounded-card ${color}`}><Icon name={icon} size={27} /></div>;
}

let clipboardClearTimer: ReturnType<typeof setTimeout> | undefined;

async function copyTransferWords(words: string) {
  await copyText(words);
  clearTimeout(clipboardClearTimer);
  const clipboard = navigator.clipboard;
  const native = platformName() !== "web";
  if (native) {
    const { readText, writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    if (await readText().catch(() => undefined) !== words) return false;
    clipboardClearTimer = setTimeout(() => {
      void readText().then((value) => { if (value === words) return writeText(""); }).catch(() => undefined);
    }, 60_000);
    return true;
  }
  // Read first only when permission is already granted. A timer must never trigger a prompt.
  const permission = clipboard && navigator.permissions
    ? await navigator.permissions.query({ name: "clipboard-read" as PermissionName }).catch(() => undefined) : undefined;
  if (permission?.state !== "granted") return false;
  clipboardClearTimer = setTimeout(() => {
    void clipboard.readText().then((value) => { if (value === words) return clipboard.writeText(""); }).catch(() => undefined);
  }, 60_000);
  return true;
}

export function ShowTransferInvitation({ invitation, expired, peer, renew }: {
  invitation?: HistoryTransferInvitation; expired: boolean; peer?: string; renew: () => void;
}) {
  const toast = useToast();
  const [image, setImage] = useState<{ invitation: HistoryTransferInvitation; url: string }>();
  const [renderFailed, setRenderFailed] = useState(false);
  const [left, setLeft] = useState(0);
  const [expiryAlert, setExpiryAlert] = useState(false);
  const wordsCard = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!invitation) return;
    let active = true;
    setRenderFailed(false);
    setExpiryAlert(false);
    void import("qrcode").then(({ default: QRCode }) => QRCode.toDataURL(JSON.stringify(invitation.qr), {
      width: 512, margin: 4, color: { dark: "#000000", light: "#ffffff" }, errorCorrectionLevel: "M",
    })).then((url) => { if (active) setImage({ invitation, url }); }).catch(() => { if (active) setRenderFailed(true); });
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((invitation.expiresAt - Date.now()) / 1000));
      setLeft(seconds);
      if (seconds <= 60) setExpiryAlert(true);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => { active = false; clearInterval(timer); setImage(undefined); };
  }, [invitation]);
  const desktop = ["macos", "windows"].includes(platformName());
  const wordsOpenByDefault = desktop || renderFailed || !navigator.mediaDevices?.getUserMedia;
  const expiryTime = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return <div className="transfer-column space-y-4">
    <TransferHeading>{t("transfer.showTitle")}</TransferHeading>
    <ol className="list-decimal space-y-1 ps-5 text-sm text-ink-muted">
      <li>{t("transfer.showStep1")}</li><li>{t("transfer.showStep2")}</li><li>{t("transfer.showStep3")}</li>
    </ol>
    {expired ? <div className="grid min-h-50 place-content-center gap-4 rounded-card bg-sunken p-4 text-center">
      <p>{t("transfer.expired")}</p><Button onClick={renew}>{t("transfer.newCode")}</Button>
    </div> : invitation && <>
      {!renderFailed && <figure className="space-y-2 text-center">
        <div role="img" aria-label={t("transfer.qrLabel")} className="mx-auto grid aspect-square w-50 max-w-full place-items-center overflow-hidden rounded-card border border-line bg-white sm:w-64">
          {image?.invitation === invitation && <img className="size-full" src={image.url} alt="" />}
        </div>
        <figcaption aria-live="off" className="text-xs text-ink-muted tabular-nums">{t("transfer.expiresIn", { time: expiryTime })}</figcaption>
        <span className="sr-only" aria-live="polite">{expiryAlert && left > 0 ? t("transfer.expiresSoon") : ""}</span>
      </figure>}
      {renderFailed && <Notice tone="warning">{t("transfer.qrUnavailable")}</Notice>}
      <Disclosure key={String(renderFailed)} defaultOpen={wordsOpenByDefault} summary={t("transfer.cantScan")} className="border-y border-line"
        onToggle={(open) => { if (open) wordsCard.current?.scrollIntoView?.({ block: "end" }); }}>
        <div ref={wordsCard} className="scroll-mb-14">
          <p className="mt-2 text-sm text-ink-muted">{t("transfer.typeWords")}</p>
          <ol dir="ltr" lang="en" className="secret-text transfer-words mt-2 rounded-control bg-sunken p-4">
            {invitation.words.split(" ").map((word, index) => <li key={index} className="break-words"><span aria-hidden="true" className="me-2 text-xs text-ink-muted">{index + 1}</span>{word}</li>)}
          </ol>
          <Button variant="secondary" leadingIcon="copy" className="my-3" aria-label={t("transfer.copyWordsLabel")} onClick={() => {
            void copyTransferWords(invitation.words).then((clears) => toast.show({ tone: "success", message: t(clears ? "transfer.wordsCopied" : "transfer.wordsCopiedPlain") }))
              .catch(() => toast.show({ tone: "danger", message: t("clipboardAccessIsUnavailable") }));
          }}>{t("transfer.copyWords")}</Button>
        </div>
      </Disclosure>
    </>}
    {!expired && <TransferWait>{peer ? t("transfer.connectingTo", { deviceName: peer }) : t("transfer.waitingOther")}</TransferWait>}
  </div>;
}

interface NativeBarcodeDetector {
  detect(image: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorConstructor {
  new(options: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

async function createQrReader(): Promise<(video: HTMLVideoElement) => Promise<string | undefined>> {
  const BarcodeDetector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  const formats: string[] | undefined = await BarcodeDetector?.getSupportedFormats().catch((): string[] => []);
  let detector = formats?.includes("qr_code") && BarcodeDetector ? new BarcodeDetector({ formats: ["qr_code"] }) : undefined;
  let decode: typeof import("jsqr")["default"] | undefined;
  const canvas = document.createElement("canvas");
  return async (video) => {
    if (video.readyState < 2 || !video.videoWidth) return;
    if (detector) {
      try { return (await detector.detect(video))[0]?.rawValue; }
      catch { detector = undefined; }
    }
    decode ??= (await import("jsqr")).default;
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return decode(pixels.data, pixels.width, pixels.height, { inversionAttempts: "dontInvert" })?.data;
  };
}

export function ScanTransferCode({ connect, enter, onViewfinder }: {
  connect: (value: string) => void; enter: () => void; onViewfinder: (visible: boolean) => void;
}) {
  const [permission, setPermission] = useState<"prompt" | "requesting" | "denied" | "granted">("prompt");
  const [detected, setDetected] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const media = useRef<MediaStream>(undefined);
  const mounted = useRef(false);
  const callbacks = useRef({ connect, enter });
  callbacks.current = { connect, enter };
  useEffect(() => {
    mounted.current = true;
    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia) callbacks.current.enter();
    else void devices.enumerateDevices?.().then((entries) => {
      if (mounted.current && !entries.some((entry) => entry.kind === "videoinput")) callbacks.current.enter();
    }).catch(() => undefined);
    return () => { mounted.current = false; media.current?.getTracks().forEach((track) => track.stop()); };
  }, []);

  const allow = async () => {
    setPermission("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (!mounted.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      media.current = stream;
      setPermission("granted");
    } catch (error) {
      if (!mounted.current) return;
      if ((error as DOMException).name === "NotFoundError") callbacks.current.enter();
      else setPermission("denied");
    }
  };

  useEffect(() => {
    onViewfinder(permission === "granted");
    return () => onViewfinder(false);
  }, [permission, onViewfinder]);

  useEffect(() => {
    if (permission !== "granted" || !video.current || !media.current) return;
    let active = true;
    let scanTimer: ReturnType<typeof setTimeout>;
    let noticeTimer: ReturnType<typeof setTimeout>;
    let lastInvalid: string | undefined;
    const element = video.current;
    element.srcObject = media.current;
    void element.play().then(createQrReader).then((read) => {
      const scan = async () => {
        if (!active) return;
        const raw = await read(element);
        if (!active) return;
        if (raw) {
          let valid = false;
          try {
            valid = raw.trimStart().startsWith("{") && !!parseTransferPairing(raw).qr;
          } catch (error) { valid = error instanceof UnsupportedTransferVersion; }
          if (valid) {
            setDetected(true);
            if (platformName() !== "web") navigator.vibrate?.(35);
            scanTimer = setTimeout(() => callbacks.current.connect(raw), 300);
            return;
          }
          if (raw !== lastInvalid) {
            lastInvalid = raw;
            setInvalid(true);
            clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => setInvalid(false), 4_000);
          }
        }
        scanTimer = setTimeout(() => void scan().catch(unavailable), 200);
      };
      return scan();
    }).catch(unavailable);
    function unavailable() {
      if (active) {
        media.current?.getTracks().forEach((track) => track.stop());
        setPermission("denied");
      }
    }
    return () => { active = false; clearTimeout(scanTimer); clearTimeout(noticeTimer); element.srcObject = null; };
  }, [permission]);

  if (permission === "granted") return <div className="transfer-scanner-layout transfer-column">
    <TransferHeading hidden>{t("transfer.scanTitle")}</TransferHeading>
    <Button variant="secondary" className="transfer-scanner-alternative" onClick={enter}>{t("transfer.enterInstead")}</Button>
    <DarkSurface aria-label={t("transfer.cameraLabel")} className="transfer-viewfinder">
      <video ref={video} autoPlay muted playsInline aria-hidden="true" />
      <div className={`transfer-reticle ${detected ? "transfer-reticle-detected" : ""}`} aria-hidden="true"><i /><i /><i /><i /></div>
      <p>{t("transfer.pointCamera")}</p>
    </DarkSurface>
    <span role="status" className="sr-only">{detected ? t("transfer.codeFound") : ""}</span>
    {invalid && <Notice tone="warning" className="transfer-scanner-notice">{t("transfer.notOurCode")}</Notice>}
  </div>;

  const help = { web: "transfer.cameraHelpWeb", ios: "transfer.cameraHelpIos", android: "transfer.cameraHelpAndroid",
    macos: "transfer.cameraHelpMac", windows: "transfer.cameraHelpWindows" } as const;
  return <div className="transfer-column transfer-fill space-y-4">
    <TransferTile icon="camera" />
    <TransferHeading>{t("transfer.scanTitle")}</TransferHeading>
    {permission === "denied" ? <Notice tone="warning" title={t("transfer.cameraOff")}>{t(help[platformName()])}</Notice>
      : <p className="text-ink-muted">{t("transfer.cameraWhy")}</p>}
    <div className="transfer-bottom transfer-pair">
      {permission === "denied" ? <>
        <Button size="lg" onClick={enter}>{t("transfer.enterInstead")}</Button>
        <Button size="lg" variant="secondary" onClick={() => void allow()}>{t("transfer.tryAgain")}</Button>
      </> : <>
        <Button size="lg" loading={permission === "requesting"} onClick={() => void allow()}>{t("transfer.allowCamera")}</Button>
        <Button size="lg" variant="ghost" onClick={enter}>{t("transfer.enterInstead")}</Button>
      </>}
    </div>
  </div>;
}

export function EnterTransferWords({ connect, connecting }: { connect: (value: string) => void; connecting: boolean }) {
  const [input, setInput] = useState("");
  const [reported, setReported] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setReported(input), 500);
    return () => clearTimeout(timer);
  }, [input]);
  const exact = inspectTransferWords(input);
  const parsed = inspectTransferWords(reported);
  const valid = exact.phrase.length === 8 && exact.count === 8;
  const submit = () => { if (valid && !connecting) connect(exact.phrase.join(" ")); };
  return <form className="transfer-column transfer-fill space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <TransferHeading>{t("transfer.enterTitle")}</TransferHeading>
    <p className="text-ink-muted">{t("transfer.enterBody")}</p>
    <Field label={t("transfer.wordsLabel")} error={parsed.unknown ? t("transfer.unknownWord", { word: parsed.unknown }) : undefined}>
      <Textarea dir="ltr" className="secret-text" value={input} onChange={(event) => setInput(event.target.value)} autoComplete="off"
        autoCapitalize="none" spellCheck={false} maxLength={512} rows={3} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
        }} />
    </Field>
    <div className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
      <span aria-live="polite">{t("transfer.wordCount", { count: parsed.count })}</span>
      {parsed.suggestion && input === reported && <Button variant="ghost" size="sm" onClick={() => {
        parsed.phrase[parsed.unknownIndex] = parsed.suggestion!;
        setInput(parsed.phrase.join(" ") + " ");
      }}>{t("transfer.didYouMean", { word: parsed.suggestion })}</Button>}
    </div>
    <Button type="submit" size="lg" fullWidth disabled={!valid} loading={connecting} className="transfer-bottom">{t("transfer.connect")}</Button>
  </form>;
}

export function CompareTransferCode({ code, sending, deviceName, otherDevice, confirmed, confirm, stop }: {
  code: string; sending: boolean; deviceName: string; otherDevice: string; confirmed: boolean; confirm: () => void; stop: () => void;
}) {
  const sameName = deviceName === otherDevice;
  const otherRole = sending ? "transfer.receivingDevice" : "transfer.sendingDevice";
  return <div className="transfer-column transfer-fill space-y-5">
    <TransferHeading>{t("transfer.checkTitle")}</TransferHeading>
    <div className="text-sm text-ink-muted">
      {sameName ? <>
        <p>{t(sending ? "transfer.sendingDevice" : "transfer.receivingDevice")} · <strong>{deviceName}</strong> · {t("transfer.thisDevice")}</p>
        <p>{t(otherRole)} · <strong>{otherDevice}</strong></p>
      </> : <>
        <DeviceNameLine label={sending ? "transfer.roleThisSending" : "transfer.roleThisReceiving"} name={deviceName} />
        <DeviceNameLine label="transfer.roleOther" name={otherDevice} />
      </>}
    </div>
    <p className="text-ink-muted">{t("transfer.checkBody")}</p>
    <div>
      <p aria-hidden="true" className="mb-2 text-sm font-semibold text-ink-muted">{t("transfer.codeLabelVisible")}</p>
      <div dir="ltr" aria-hidden="true" className="secret-text flex flex-wrap justify-center gap-x-5 rounded-control bg-sunken px-3 py-4 text-[1.75rem] font-bold tabular-nums">
        <span>{code.slice(0, 3)}</span><span>{code.slice(3)}</span>
      </div>
      <p className="sr-only">{t("transfer.checkLabel", { spelled: [...code].join(" ") })}</p>
    </div>
    <div className={`transfer-bottom ${confirmed ? "space-y-3" : "transfer-pair"}`}>
      {confirmed ? <TransferWait>{t("transfer.waitingConfirm", { deviceName: sameName ? t(otherRole) : otherDevice })}</TransferWait>
        : <Button size="lg" onClick={confirm}>{t("transfer.codesMatch")}</Button>}
      <Button size="lg" variant="secondary" onClick={stop}>{t("transfer.stopTransfer")}</Button>
    </div>
  </div>;
}
function DeviceNameLine({ label, name }: { label: "transfer.roleThisSending" | "transfer.roleThisReceiving" | "transfer.roleOther"; name: string }) {
  const [before, after] = t(label, { deviceName: "\u0001" }).split("\u0001");
  return <p>{before}<strong className="text-ink">{name}</strong>{after}</p>;
}
