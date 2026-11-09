import { useCallback, useEffect, useState } from "react";
import type { Provider, Streamer, StreamerAccess, SupportSettings, Viewer } from "../../types";
import { errorMessage, requestJson } from "../api";

/** `GET /api/me`: everything the account dialogs show. */
export interface Me {
  viewer: Viewer | null;
  streamer: Streamer | null;
  /** The owner's support links, for the Edit your page section. */
  support: SupportSettings | null;
  access: StreamerAccess | null;
  providers: Provider[];
  signInProvider: Provider | null;
}

/** Loads `/api/me` while `active`, and again on `reload()` (after a save). */
export function useMe(active: boolean): { me: Me | null; error: string; reload: () => Promise<void> } {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string>("");
  // Closing drops what was loaded: dialogs set their drafts once, so a reopen waits for fresh data instead of
  // starting from values a save has since changed. Adjusted while rendering, not in an effect.
  const [wasActive, setWasActive] = useState<boolean>(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) {
      setMe(null);
      setError("");
    }
  }
  const reload = useCallback(async (): Promise<void> => {
    try {
      setMe(await requestJson<Me>("/api/me"));
      setError("");
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    let current = true;
    requestJson<Me>("/api/me").then(
      (value: Me) => {
        if (!current) return;
        setMe(value);
        setError("");
      },
      (error_: unknown) => {
        if (current) setError(errorMessage(error_));
      },
    );
    return () => {
      current = false;
    };
  }, [active]);
  return { me, error, reload };
}

export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** PUTs an image (a cropped JPEG blob or a chosen file) to `/api/images/{kind}`. */
export async function uploadImage(kind: "avatar" | "logo" | "background", body: Blob): Promise<string> {
  const { url } = await requestJson<{ url: string }>(`/api/images/${kind}`, {
    method: "PUT",
    headers: { "Content-Type": body.type || "image/jpeg" },
    body,
  });
  return url;
}
