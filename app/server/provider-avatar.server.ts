import type { AppEnv } from "../env";
import { readBody } from "./http.server";
import { uploadImage } from "./images.server";

export function allowedProviderPhoto(value: string, provider: string | null): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (provider === "google") return url.hostname === "lh3.googleusercontent.com";
  return provider === "twitch" && url.hostname === "static-cdn.jtvnw.net";
}

export async function importProviderPhoto(
  env: AppEnv,
  userId: string,
  source: string,
  provider: string | null,
): Promise<void> {
  if (!allowedProviderPhoto(source, provider)) return;
  try {
    const response: Response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Provider photo unavailable");
    const bytes = await readBody(response, 5 * 1024 * 1024);
    await uploadImage(
      new Request(`${env.APP_ORIGIN}/api/images/avatar`, {
        method: "PUT",
        headers: { "Content-Type": response.headers.get("Content-Type") ?? "" },
        body: bytes,
      }),
      env,
      userId,
      "avatar",
    );
  } catch {
    console.warn("provider_avatar_import_failed");
  }
}
