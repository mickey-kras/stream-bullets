import notices from "../../THIRD_PARTY_NOTICES.md?raw";
import { HttpError } from "./http.server";

// The licenses and notices of the packages the app ships, served from the build that ships them. CI checks the file
// against the installed packages (scripts/third-party-notices.ts), so it matches the JavaScript of this version.
export const NOTICES_PATH = "/third-party-notices.txt";

export function noticesResponse(request: Request): Response {
  if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
  return new Response(request.method === "HEAD" ? null : notices, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
