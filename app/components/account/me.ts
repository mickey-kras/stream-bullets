import { useCallback, useEffect, useState } from "react";
import type { Provider, Streamer, StreamerAccess, SupportSettings, Viewer } from "../../types";
import { errorMessage, requestJson } from "../api";

// GET /api/me data for account dialogs.
export interface Me {
  viewer: Viewer | null;
  streamer: Streamer | null;

  support: SupportSettings | null;
  access: StreamerAccess | null;
  providers: Provider[];
  signInProvider: Provider | null;
}

// Load while active; reload after saves.
export function useMe(active: boolean): { me: Me | null; error: string; reload: () => Promise<void> } {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string>("");
  // Clear data on close so reopened drafts await fresh values. Adjust during render, not an effect.
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

// PUT a JPEG crop or selected file to /api/images/{kind}.
export async function uploadImage(kind: "avatar" | "logo" | "background", body: Blob): Promise<string> {
  const { url } = await requestJson<{ url: string }>(`/api/images/${kind}`, {
    method: "PUT",
    headers: { "Content-Type": body.type || "image/jpeg" },
    body,
  });
  return url;
}
