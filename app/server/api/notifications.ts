import { z } from "zod";
import { consumeMutationQuota } from "../data.server";
import { listNotifications, markNotification, saveNotificationPreferences } from "../discussion-notifications.server";
import { json, queryParams, readJson } from "../http.server";
import { get, requireViewer, write, type ApiRoute } from "./router";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), id: z.string().regex(/^[a-f0-9]{32}$/u), read: z.boolean() }).strict(),
  z.object({ action: z.literal("preferences"), replies: z.boolean(), mentions: z.boolean() }).strict(),
]);

export const notificationRoutes: ApiRoute[] = [
  get(/notifications/, async ({ request, env, viewer }) => {
    const user = requireViewer(viewer);
    const query = queryParams(request, ["cursor"]);
    return json(await listNotifications(env, user.id, query.get("cursor")));
  }),
  write("POST", /notifications/, async ({ request, env, viewer }) => {
    const action = await readJson(request, actionSchema);
    await consumeMutationQuota(env, viewer.id);
    if (action.action === "read") await markNotification(env, viewer.id, action.id, action.read);
    else await saveNotificationPreferences(env, viewer.id, action);
    return json({ ok: true });
  }),
];
