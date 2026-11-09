import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate, useRevalidator } from "react-router";
import { t } from "../../i18n";
import { personPicture, type PictureSource } from "../../lib/avatars";
import { renamedPath } from "../../lib/shell";
import type { Streamer, SupportSettings, Viewer } from "../../types";
import { errorMessage } from "../api";
import { OwnerNotice } from "../streamer/page-banner";
import { SupportFields, supportChanged, supportDraftError, supportPayload, useSupportDraft } from "../support/support";
import { formatDate } from "../waitlist";
import { bumpImage, Picture, useImageUrl } from "../ui/avatar";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { Cropper, type CropperHandle } from "./cropper";
import { useDiscardGuard } from "./discard";
import { sendJson, uploadImage } from "./me";
import { UploadField } from "./profile-dialog";
import { Req, RequiredNote } from "../ui/required";

/** A handle can change once every 30 days (R11). */
export const HANDLE_CHANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When the handle can next change, or null when it can change now. */
export function nextHandleChange(handleChangedAt: number | null, now: number): number | null {
  if (handleChangedAt === null) return null;
  const next: number = handleChangedAt + HANDLE_CHANGE_DAYS * DAY_MS;
  return next > now ? next : null;
}

const LOGO_CHOICES: readonly (readonly ["profile" | "logo", "page.useProfile" | "page.uploadLogo"])[] = [
  ["profile", "page.useProfile"],
  ["logo", "page.uploadLogo"],
];

interface Draft {
  blob: Blob;
  url: string;
}

const NO_SUPPORT: SupportSettings = { links: [], visible: true, card: false };

type PagePatch = { name?: string; about?: string; handle?: string; logoMode?: "profile" | "logo" };

function pagePatch(
  streamer: Streamer,
  name: string,
  about: string,
  handle: string,
  logoChoice: "profile" | "logo",
  initialLogo: "profile" | "logo",
  logo: Draft | null,
): PagePatch {
  const patch: PagePatch = {};
  if (name.trim() !== streamer.name) patch.name = name.trim();
  if (about.trim() !== streamer.about.trim()) patch.about = about.trim();
  if (handle.trim() !== streamer.handle) patch.handle = handle.trim();
  if (logoChoice !== initialLogo || logo) patch.logoMode = logoChoice;
  return patch;
}

function pageChanges(patch: PagePatch, background: Draft | null, supportEdited: boolean): string[] {
  const changes: string[] = [];
  if (patch.name !== undefined) changes.push(t("page.name"));
  if (patch.handle !== undefined) changes.push(t("page.handle"));
  if (patch.about !== undefined) changes.push(t("page.about"));
  if (patch.logoMode !== undefined) changes.push(t("page.logo"));
  if (background) changes.push(t("page.background"));
  if (supportEdited) changes.push(t("support.editorTitle"));
  return changes;
}

function BackgroundPreview({ draft, saved }: Readonly<{ draft: Draft | null; saved: string | null }>): ReactNode {
  const url: string | null = draft?.url ?? saved;
  return url ? <img className="background-preview" src={url} alt={t("page.backgroundAlt")} /> : null;
}

function pagePreview(logoChoice: "profile" | "logo", logoUrl: string | null, viewer: Viewer): PictureSource {
  if (logoChoice === "logo" && logoUrl) return { kind: "photo", url: logoUrl };
  return personPicture(viewer.avatar, viewer.avatarPreset);
}

function PageActions({
  cropping,
  pending,
  onCrop,
}: Readonly<{
  cropping: boolean;
  pending: boolean;
  onCrop: () => Promise<void>;
}>): ReactNode {
  if (cropping) {
    return (
      <DialogActions cancel={false}>
        <button className="gold" type="button" onClick={onCrop}>
          <Icon name="check" size={18} />
          {t("crop.use")}
        </button>
      </DialogActions>
    );
  }
  return (
    <DialogActions>
      <button className="gold" type="submit" form="page-form" disabled={pending}>
        <Icon name="check" size={18} />
        {pending ? t("profile.saving") : t("page.save")}
      </button>
    </DialogActions>
  );
}

/**
 * "Edit your page" (item 18): page name, handle (with the URL-change warning, once every 30 days), about,
 * the page logo (use my profile picture, or upload one through the circle cropper), the support links (item 34)
 * and the page background.
 * Everything, the cropped logo included, is a draft until Save; closing with changes asks first.
 */
export function EditPageDialog({
  streamer,
  support,
  viewer,
  onClose,
}: Readonly<{ streamer: Streamer; support: SupportSettings | null; viewer: Viewer; onClose: () => void }>): ReactNode {
  const toast = useToast();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const location = useLocation();
  const [name, setName] = useState<string>(streamer.name);
  const [handle, setHandle] = useState<string>(streamer.handle);
  const [about, setAbout] = useState<string>(streamer.about);
  const initialLogo: "profile" | "logo" = streamer.logo ? "logo" : "profile";
  const [logoChoice, setLogoChoice] = useState<"profile" | "logo">(initialLogo);
  const [logo, setLogo] = useState<Draft | null>(null);
  const [background, setBackground] = useState<Draft | null>(null);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const [now] = useState<number>(() => Date.now());
  const cropper = useRef<CropperHandle | null>(null);
  const urls = useRef<Set<string>>(new Set());
  const savedBackground: string | null = useImageUrl(streamer.background);
  const savedSupport: SupportSettings = support ?? NO_SUPPORT;
  const supportDraft = useSupportDraft(savedSupport);

  useEffect(() => {
    const created = urls.current;
    return () => {
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, []);

  function objectUrl(blob: Blob): string {
    const url: string = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  }

  const locked: number | null = nextHandleChange(streamer.handleChangedAt, now);
  const logoUrl: string | null = logo?.url ?? streamer.logo;
  const patch: PagePatch = pagePatch(streamer, name, about, handle, logoChoice, initialLogo, logo);
  const supportEdited: boolean = supportChanged(supportDraft, savedSupport);
  const changes: string[] = pageChanges(patch, background, supportEdited);
  const guard = useDiscardGuard(changes, onClose);

  async function saveImages(): Promise<void> {
    if (logoChoice === "logo" && logo) bumpImage(await uploadImage("logo", logo.blob));
    if (background) bumpImage(await uploadImage("background", background.blob));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (!event.currentTarget.reportValidity()) return;
    if (logoChoice === "logo" && !logoUrl) {
      setError(t("page.logoMissing"));
      return;
    }
    const supportError: string = supportEdited ? supportDraftError(supportDraft) : "";
    if (supportError) {
      setError(supportError);
      return;
    }
    setPending(true);
    setError("");
    try {
      await saveImages();
      let saved: Streamer = streamer;
      if (Object.keys(patch).length > 0)
        saved = (await sendJson<{ streamer: Streamer }>("PATCH", "/api/streamer", patch)).streamer;
      if (supportEdited) await sendJson<SupportSettings>("PUT", "/api/support-links", supportPayload(supportDraft));
      toast(t("page.saved"));
      const moved = renamedPath(location.pathname, streamer.handle, saved.handle);
      if (saved.handle !== streamer.handle && moved) {
        // The old address stops working (no redirects): move to the new one. The root loader skips plain
        // navigations, so the shell's links to the page are reloaded as well.
        await navigate(moved, { replace: true });
        await revalidator.revalidate();
        return;
      }
      await revalidator.revalidate();
      onClose();
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setPending(false);
    }
  }

  async function applyCrop(): Promise<void> {
    const handleRef: CropperHandle | null = cropper.current;
    if (!handleRef) return;
    try {
      const blob: Blob = await handleRef.exportBlob();
      setLogo({ blob, url: objectUrl(blob) });
      setLogoChoice("logo");
      setCropSource(null);
      setError("");
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }

  const cropping: boolean = cropSource !== null;
  const handleChanged: boolean = handle.trim() !== streamer.handle;
  const preview: PictureSource = pagePreview(logoChoice, logoUrl, viewer);

  return (
    <Sheet
      open
      onOpenChange={guard.onOpenChange}
      name="page"
      title={cropping ? t("page.cropTitle") : t("account.editPage")}
      description={cropping ? t("page.cropDescription") : undefined}
      onBack={cropping ? () => setCropSource(null) : undefined}
      actions={<PageActions cropping={cropping} pending={pending} onCrop={applyCrop} />}
    >
      {cropping ? (
        <>
          <p className="muted">{t("page.cropDescription")}</p>
          <Cropper ref={cropper} src={cropSource ?? ""} kind="page" onError={setError} />
          <p className="form-error" role="alert">
            {error}
          </p>
        </>
      ) : (
        <form id="page-form" onSubmit={(event: FormEvent<HTMLFormElement>) => void save(event)}>
          <OwnerNotice status={streamer.status} reason={streamer.statusReason} changedAt={streamer.statusChangedAt} />
          <RequiredNote />
          <label>
            <span>
              {t("page.name")}
              <Req />
            </span>
            <input name="name" value={name} onChange={(e) => setName(e.currentTarget.value)} required maxLength={40} />
          </label>
          <label>
            <span>
              {t("page.handle")}
              <Req />
            </span>
            <input
              name="handle"
              value={handle}
              onChange={(e) => setHandle(e.currentTarget.value)}
              required
              minLength={3}
              maxLength={30}
              pattern="[a-z0-9_]{3,30}"
              autoCapitalize="none"
              spellCheck={false}
              readOnly={locked !== null}
              aria-describedby="page-handle-help handle-warn"
            />
          </label>
          <p className="muted" id="page-handle-help">
            {locked === null ? t("page.handleHelp") : t("page.handleLocked", { date: formatDate(locked) })}
          </p>
          <output className="handle-warn" id="handle-warn">
            {handleChanged && (
              <>
                <Icon name="warning" size={16} />
                {t("page.handleWarning")}
              </>
            )}
          </output>
          <label>
            <span>{t("page.about")}</span>
            <textarea
              name="about"
              value={about}
              onChange={(e) => setAbout(e.currentTarget.value)}
              maxLength={2000}
              rows={4}
            />
          </label>
          <fieldset className="logo-choice">
            <legend>{t("page.logo")}</legend>
            <div className="logo-row">
              <div className="logo-preview" aria-hidden="true">
                <Picture source={preview} />
              </div>
              <div className="choice-list" role="radiogroup" aria-label={t("page.logoSource")}>
                {LOGO_CHOICES.map(([value, label]) => (
                  <label className="choice" key={value}>
                    <input
                      type="radio"
                      name="logo-choice"
                      value={value}
                      checked={logoChoice === value}
                      onChange={() => setLogoChoice(value)}
                    />
                    <span>{t(label)}</span>
                  </label>
                ))}
              </div>
            </div>
            {logoChoice === "logo" && (
              <div className="logo-upload">
                <UploadField
                  label={logoUrl ? t("page.replaceLogo") : t("page.logoImage")}
                  onInvalid={setError}
                  onFile={(file: File) => {
                    setError("");
                    setCropSource(objectUrl(file));
                  }}
                />
                {logoUrl && (
                  <button type="button" className="text-button" onClick={() => setCropSource(logoUrl)}>
                    <Icon name="crop" size={16} />
                    {t("page.adjustLogo")}
                  </button>
                )}
              </div>
            )}
            <p className="muted">{t("page.logoHelp")}</p>
          </fieldset>
          <SupportFields draft={supportDraft} />
          <fieldset>
            <legend>{t("page.background")}</legend>
            <UploadField
              label={t("page.backgroundImage")}
              icon="image"
              onInvalid={setError}
              onFile={(file: File) => {
                setError("");
                setBackground({ blob: file, url: objectUrl(file) });
              }}
            />
            <p className="muted">{t("page.backgroundHelp")}</p>
            <BackgroundPreview draft={background} saved={savedBackground} />
          </fieldset>
          <p className="form-error" role="alert">
            {error}
          </p>
        </form>
      )}
      {guard.confirm}
    </Sheet>
  );
}
