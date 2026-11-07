import { z } from "zod";
import { listComments, mutateComment } from "../comments.server";
import { getVisibleEntry } from "../data.server";
import { HttpError, json, queryParams, readJson } from "../http.server";
import { requireAdminSession } from "../stepup.server";
import { commentActionSchema, commentQuerySchema } from "../validation";
import { get, parsedQuery, write, type ApiRoute } from "./router";

const entryPath = /entries\/([a-f0-9-]{36})(\/comments)?/;

/** A single topic or poll, its discussion, and comment actions. */
export const entryRoutes: ApiRoute[] = [
  // GET /api/entries/:id → {entry}
  // GET /api/entries/:id/comments?sort&cursor&view=flat|thread → DiscussionSnapshot | ThreadSnapshot
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
