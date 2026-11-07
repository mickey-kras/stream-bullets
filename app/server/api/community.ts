import { z } from "zod";
import { saveCards } from "../community.server";
import { json, readJson } from "../http.server";
import { saveSupport } from "../support.server";
import { write, type ApiRoute } from "./router";

/** The owner's Community cards (item 24) and support links (item 34). Both replace the whole list. */
export const communityRoutes: ApiRoute[] = [
  // PUT /api/community-cards {cards: [{icon, title, body, buttonLabel, buttonTarget}] (≤ 8)} → {cards}
  write("PUT", /community-cards/, async ({ request, env, viewer }) =>
    json({ cards: await saveCards(env, viewer.id, await readJson(request, z.unknown())) }),
  ),
  // PUT /api/support-links {links: [{kind, label, url}] (≤ 4), visible, card} → {links, visible, card}
  write("PUT", /support-links/, async ({ request, env, viewer }) =>
    json(await saveSupport(env, viewer.id, await readJson(request, z.unknown()))),
  ),
];
