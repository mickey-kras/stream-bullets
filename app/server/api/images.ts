import { consumeMutationQuota } from "../data.server";
import { json } from "../http.server";
import { deleteLogo, uploadImage } from "../images.server";
import { write, type ApiRoute } from "./router";

/** Image uploads. The body is the raw PNG, JPEG or WebP file with its Content-Type. */
export const imageRoutes: ApiRoute[] = [
  // PUT /api/images/avatar|background|logo → {url}
  write("PUT", /images\/(avatar|background|logo)/, async ({ request, env, match, viewer }) => {
    await consumeMutationQuota(env, viewer.id, true);
    return json({ url: await uploadImage(request, env, viewer.id, match[1]) });
  }),
  // DELETE /api/images/logo → {logo: null}: the page uses the owner's profile picture again.
  write("DELETE", /images\/logo/, async ({ env, viewer }) => {
    await consumeMutationQuota(env, viewer.id);
    await deleteLogo(env, viewer.id);
    return json({ logo: null });
  }),
];
