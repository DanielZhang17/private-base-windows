import { t, useLocale } from "../../i18n/index.js";
import { useEffect } from "react";
import { Avatar, Button, Field, Input, Icon, ToastProvider, useToast } from "../../ui/index.js";
import { useAvatarPicker } from "../../features/settings/useAvatarPicker.js";

interface AvatarPickerProps {
  value: string | null;
  onChange: (avatarUrl: string) => void;
  onLocalFile?: (file: File) => void;
}

function Picker({ value, onChange, onLocalFile }: AvatarPickerProps) {
  useLocale();
  const p = useAvatarPicker(value, onChange, onLocalFile);
  const toast = useToast();
  useEffect(() => { if (p.noticeMessage) { toast.show({ tone: "danger", message: p.noticeMessage }); p.dismissNotice(); } }, [p.noticeMessage, p.dismissNotice, toast]);
  return <div className="space-y-4">

    <div className="flex rounded-control bg-sunken p-1" aria-label={t("pictureSource")}>
      {([['genshin', 'Genshin'], ['dicebear', t("generatedAvatarSourceTab")], ['upload', t("avatarUploadSourceTab")]] as const).map(([key, label]) => <Button
        key={key}
        variant={p.tab === key ? "secondary" : "ghost"}
        className="min-w-0 flex-1 px-2"
        aria-pressed={p.tab === key}
        onClick={() => p.setTab(key)}
      >
        {label}
      </Button>)}
    </div>

    {p.tab === "genshin" && <Field label={t("searchCharacters")}>
      <Input
        placeholder={t("searchCharacters2")}
        value={p.search}
        onChange={(event) => p.setSearch(event.target.value)}
      />
    </Field>}

    {p.tab === "dicebear" && <div className="flex items-center justify-between gap-2">
      <p className="text-sm text-ink-muted">{t("pickAStyle")}</p>
      <Button
        variant="ghost"
        leadingIcon="retry"
        onClick={p.randomize}
      >{t("randomizeAvatarsAction")}</Button>
    </div>}

    {p.tab !== "upload" && <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto p-1 sm:grid-cols-4 xl:grid-cols-6">
      {(p.tab === "genshin" ? p.characters : p.generated).map((avatar) => <button
        type="button"
        key={avatar.value}
        aria-label={t("choose", { name: avatar.name })}
        aria-pressed={value === avatar.value}
        className={`flex min-h-16 min-w-11 flex-col items-center gap-1 rounded-control p-2 hover:bg-sunken ${value === avatar.value ? "bg-brand-soft ring-2 ring-brand" : ""}`}
        onClick={() => onChange(avatar.value)}
      >
        <Avatar
          name={avatar.name}
          src={avatar.src}
          size="sm"
        />
        <span className="w-full truncate text-center text-xs">
          {avatar.name}
        </span>
      </button>)}
    </div>}

    {p.tab === "upload" && <div className="flex flex-col items-center gap-4 rounded-card border border-dashed border-line p-5">

      {value?.startsWith("r2://") ? <Avatar
        name={t("selfAvatarFallback")}
        src={p.uploadedSrc}
        size="lg"
      /> : <Icon
        name="image"
        size={32}
        className="text-ink-muted"
      />}

      <Field label={p.uploading ? t("uploadingImage") : t("selectImage")}>
        <Input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={p.uploading}
          onChange={p.handleFileUpload}
        />
      </Field>

      <p className="text-center text-xs text-ink-muted">{t("jpegPngOrWebpMax2Mb")}<br />{t("uploadedAvatarsArePublic")}</p>

    </div>}

  </div>;
}
export default function AvatarPicker(props: AvatarPickerProps) {
  return <ToastProvider>
    <Picker {...props} />
  </ToastProvider>;
}
