import { z } from "zod";
import { CTA_EVENTS } from "../../lib/conversions";
import { json, readJson, requireSameOrigin } from "../http.server";
import { openWrite, type ApiRoute } from "./router";

const clickSchema = z.strictObject({ id: z.string().uuid(), event: z.enum(CTA_EVENTS) });

// Clients can report clicks only. Completion counts come from committed database writes.
export const conversionRoutes: ApiRoute[] = [
  openWrite("POST", /conversions/, async ({ request, env }) => {
    requireSameOrigin(request, env);
    const { id, event } = await readJson(request, clickSchema);
    const result = await env.DB.prepare(
      "INSERT INTO conversion_clicks (id,event,created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(id, event, Date.now())
      .run();
    return json({ counted: result.meta.changes > 0 });
  }),
];
