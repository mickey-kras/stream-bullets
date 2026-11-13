import { z } from "zod";
import { getCommentThread, listComments, mutateComment } from "../comments.server";
import { mentionCandidates } from "../discussion-notifications.server";
import { getVisibleEntry } from "../data.server";
import { HttpError, json, queryParams, readJson } from "../http.server";
import { requireAdminSession } from "../stepup.server";
import { commentActionSchema, commentQuerySchema } from "../validation";
import { get, parsedQuery, requireViewer, write, type ApiRoute } from "./router";

const entryPath = /entries\/([a-f0-9-]{36})(\/comments)?/;

export const entryRoutes: ApiRoute[] = [
  get(/comments\/([a-f0-9-]{36})/, async ({ request, env, match, viewer }) => {
    queryParams(request, []);
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Comment not found.");
    return json(await getCommentThread(env, match[1], viewer?.id ?? null));
  }),
  get(/entries\/([a-f0-9-]{36})\/mention-candidates/, async ({ request, env, match, viewer }) => {
    const user = requireViewer(viewer);
    const entry = await getVisibleEntry(env, match[1], user.id);
    if (!entry) throw new HttpError(404, "Topic or poll not found.");
    const query = parsedQuery(request, ["query"], z.object({ query: z.string().trim().max(40).default("") }).strict());
    return json({ users: await mentionCandidates(env, entry.streamerId, query.query) });
  }),
  // GET /api/entries/:id → {entry} GET /api/entries/:id/comments?sort&cursor&view=flat|thread →
  // DiscussionSnapshot | ThreadSnapshot
  get(entryPath, async ({ request, env, match, viewer }) => {
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Endpoint not found.");
    const entry = await getVisibleEntry(env, match[1], viewer?.id ?? null);
    if (!entry) throw new HttpError(404, "Topic or poll not found.");
    if (match[2]) {
      const input = parsedQuery(request, ["sort", "cursor", "view"], commentQuerySchema);
      return json(await listComments(env, entry.id, viewer?.id ?? null, input));
    }
    queryParams(request, []);
    return json({ entry });
  }),
  // An admin removal of someone else's comment passes the same step-up gate as the admin routes.
  write("POST", /comments/, async ({ request, app, env, viewer }) =>
    json(
      await mutateComment(env, viewer.id, await readJson(request, commentActionSchema), () =>
        requireAdminSession(request, app),
      ),
    ),
  ),
];
