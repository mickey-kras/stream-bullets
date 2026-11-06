import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { t } from "../../i18n";
import { DEFAULT_AVATAR_PRESET, isAvatarPreset } from "../../lib/avatars";
import type { Provider, Viewer } from "../../types";
import { errorMessage } from "../api";
import { providerName } from "../shell/sign-in-dialog";
import { bumpImage, Picture } from "../ui/avatar";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { AvatarPicker, type AvatarChoice } from "./avatar-picker";
import { Cropper, type CropperHandle } from "./cropper";
import { useDiscardGuard } from "./discard";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, sendJson, uploadImage } from "./me";

/** "Signed in with Google" (with the provider's mark) at the top of Your profile and Your data. */
export function SignedInWith({ provider }: Readonly<{ provider: Provider | null }>): ReactNode {
  if (!provider) return null;
  return (
    <p className="signed-in-with">
      <Icon name={provider} size={16} />
      <span>{t("account.signedInWith", { provider: providerName[provider] })}</span>
    </p>
  );
}

/** A file input styled as a button (review m20). Checks type and size before handing the file on. */
export function UploadField({
  label,
  icon = "upload",
  onFile,
  onInvalid,
}: Readonly<{
  label: string;
  icon?: "upload" | "image";
  onFile: (file: File) => void;
  onInvalid: (message: string) => void;
}>): ReactNode {
  return (
    <label className="upload-field">
      <span className="upload-label">
        <Icon name={icon} size={18} />
        {label}
      </span>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file: File | undefined = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) {
            onInvalid(t("upload.invalid"));
            return;
          }
          onFile(file);
        }}
      />
    </label>
  );
}

interface NewPhoto {
  /** The original file, for "Adjust your photo". */
  source: string;
  blob: Blob;
  url: string;
}

function initialChoice(viewer: Viewer): AvatarChoice {
  if (viewer.avatar) return "photo";
  return isAvatarPreset(viewer.avatarPreset) ? viewer.avatarPreset : DEFAULT_AVATAR_PRESET;
}

/**
 * "Your profile" (items 7, 9, 13, 17): display name and picture with a live preview. Nothing applies until
 * Save. Uploading opens the "Adjust your picture" step in the same dialog; the cropped 512px JPEG becomes the
 * "Your photo" option. Choosing a preset over an uploaded photo removes the upload on Save.
 */
export function ProfileDialog({
  viewer,
  provider,
  onClose,
}: Readonly<{ viewer: Viewer; provider: Provider | null; onClose: () => void }>): ReactNode {
  const toast = useToast();
  const revalidator = useRevalidator();
  const [name, setName] = useState<string>(viewer.name);
  const [choice, setChoice] = useState<AvatarChoice>(() => initialChoice(viewer));
  const [photo, setPhoto] = useState<NewPhoto | null>(null);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const cropper = useRef<CropperHandle | null>(null);
  const urls = useRef<Set<string>>(new Set());

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

  const photoUrl: string | null = photo?.url ?? viewer.avatar;
  const changes: string[] = [];
  if (name.trim() !== viewer.name) changes.push(t("profile.displayName"));
  if (choice !== initialChoice(viewer) || photo) changes.push(t("profile.picture"));
  const guard = useDiscardGuard(changes, onClose);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const trimmed: string = name.trim();
    if (!trimmed) {
      setError(t("profile.nameRequired"));
      return;
    }
    setPending(true);
    setError("");
    try {
      if (choice === "photo" && photo) bumpImage(await uploadImage("avatar", photo.blob));
      if (choice !== "photo" && viewer.avatar) await sendJson("DELETE", "/api/images/avatar");
      const patch: { name?: string; avatarPreset?: number | null } = {};
      if (trimmed !== viewer.name) patch.name = trimmed;
      if (choice !== "photo" && choice !== viewer.avatarPreset) patch.avatarPreset = choice;
      if (patch.name !== undefined || patch.avatarPreset !== undefined) await sendJson("PATCH", "/api/profile", patch);
      await revalidator.revalidate();
      toast(t("profile.saved"));
      onClose();
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setPending(false);
    }
  }


  async function applyCrop(): Promise<void> {
    const handle: CropperHandle | null = cropper.current;
    if (!handle) return;
    try {
      const blob: Blob = await handle.exportBlob();
      setPhoto({ source: cropSource ?? "", blob, url: objectUrl(blob) });
      setChoice("photo");
      setCropSource(null);
      setError("");
      // Back on the profile step, focus the photo option the crop selected.
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.avatar-grid [data-avatar="photo"]')?.focus());
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }

  const cropping: boolean = cropSource !== null;
  return (
    <Sheet
      open
      onOpenChange={guard.onOpenChange}
      name="profile"
      title={cropping ? t("crop.title") : t("account.yourProfile")}
      description={cropping ? t("crop.description") : undefined}
      onBack={cropping ? () => setCropSource(null) : undefined}
      actions={
        cropping ? (
          <DialogActions cancel={false}>
            <button className="gold" type="button" onClick={() => void applyCrop()}>
              <Icon name="check" size={18} />
              {t("crop.use")}
            </button>
          </DialogActions>
        ) : (
          <DialogActions>
            <button className="gold" type="submit" form="profile-form" disabled={pending}>
              <Icon name="check" size={18} />
              {pending ? t("profile.saving") : t("profile.save")}
            </button>
          </DialogActions>
        )
      }
    >
      {cropping ? (
        <>
          <p className="muted">{t("crop.description")}</p>
          <Cropper ref={cropper} src={cropSource ?? ""} kind="profile" onError={setError} />
          <p className="form-error" role="alert">
            {error}
          </p>
        </>
      ) : (
        <form id="profile-form" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => void save(event)}>
          <p className="form-error" role="alert">
            {error}
          </p>
          <SignedInWith provider={provider} />
          <div className="avatar-preview">
            <Picture
              source={
                choice === "photo" && photoUrl
                  ? { kind: "photo", url: photoUrl }
                  : { kind: "preset", preset: choice === "photo" ? DEFAULT_AVATAR_PRESET : choice }
              }
            />
            <span className="preview-name">{name.trim() || "…"}</span>
          </div>
          <label>
            <span>{t("profile.displayName")}</span>
            <input
              name="name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              minLength={1}
              maxLength={40}
              autoComplete="nickname"
            />
          </label>
          <AvatarPicker
            value={choice}
            photo={photoUrl}
            onChange={setChoice}
            onAdjust={() => setCropSource(photo?.source || photoUrl)}
          />
          <UploadField
            label={t("profile.upload")}
            onInvalid={setError}
            onFile={(file: File) => {
              setError("");
              setCropSource(objectUrl(file));
            }}
          />
          <p className="muted">{t("upload.help")}</p>
        </form>
      )}
      {guard.confirm}
    </Sheet>
  );
}
