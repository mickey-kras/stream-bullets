import { useCallback, useEffect, useState } from "react";
import type { Provider, Streamer, StreamerAccess, Viewer } from "../../types";
import { errorMessage, requestJson } from "../api";

/** `GET /api/me`: everything the account dialogs show. */
export interface Me {
  viewer: Viewer | null;
  streamer: Streamer | null;
  access: StreamerAccess | null;
  providers: Provider[];
  signInProvider: Provider | null;
}

/** Loads `/api/me` while `active`, and again on `reload()` (after a save). */
export function useMe(active: boolean): { me: Me | null; error: string; reload: () => Promise<void> } {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string>("");
  const reload = useCallback(async (): Promise<void> => {
    try {
      setMe(await requestJson<Me>("/api/me"));
      setError("");
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }, []);
  useEffect(() => {
    if (!active) {
      setMe(null);
      return;
    }
    void reload();
  }, [active, reload]);
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

export async function sendJson<T>(method: "PATCH" | "POST" | "DELETE", url: string, body?: unknown): Promise<T> {
  return requestJson<T>(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
