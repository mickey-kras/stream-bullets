import { z } from "zod";
import { saveCards } from "../community.server";
import { getOwnStreamer } from "../data.server";
import { json, readJson } from "../http.server";
import { notifyOverlay } from "../live.server";
import { refreshOverlayFor } from "../overlay.server";
import { saveSupport } from "../support.server";
import { write, type ApiRoute } from "./router";

// Community cards and support links replace their entire lists.
export const communityRoutes: ApiRoute[] = [
  // PUT /api/community-cards {cards: [{id?, icon, title, body, buttonLabel, buttonTarget}] (≤ 8)} → {cards}
  write("PUT", /community-cards/, async ({ request, env, viewer }) => {
    const cards = await saveCards(env, viewer.id, await readJson(request, z.unknown()));
    // The OBS page reloads a card it shows, or drops one that was removed.
    notifyOverlay(env, (await getOwnStreamer(env, viewer.id))!.id);
    return json({ cards });
  }),
  // PUT /api/support-links {links: [{kind, label, url}] (≤ 4), visible, card} → {links, visible, card}
  write("PUT", /support-links/, async ({ request, env, viewer }) => {
    const support = await saveSupport(env, viewer.id, await readJson(request, z.unknown()));
    // The Support source shows the first link, so an overlay showing it reloads.
    await refreshOverlayFor(env, viewer.id, ["support"]);
    return json(support);
  }),
];
