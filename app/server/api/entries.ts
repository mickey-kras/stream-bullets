import { z } from "zod";
import { getCommentThread, listComments, mutateComment } from "../comments.server";
import { mentionCandidates } from "../discussion-notifications.server";
import { getVisibleEntry } from "../data.server";
import { HttpError, json, queryParams, readJson } from "../http.server";
import { requireAdminSession } from "../stepup.server";
import { attachEntryTranslations, entryTranslationSchema, translateEntry } from "../entry-translation.server";
import { translateAfterPost } from "../translation-jobs.server";
import { attachTranslations, translateComment, translationSchema } from "../translation.server";
import { requestLocale } from "../../i18n/resolve";
import type { Comment, CommentThread } from "../../types";
import { commentActionSchema, commentQuerySchema } from "../validation";
import { get, parsedQuery, requireViewer, write, type ApiRoute } from "./router";

const entryPath = /entries\/([a-f0-9-]{36})(\/comments)?/;

export const entryRoutes: ApiRoute[] = [
  get(/comments\/([a-f0-9-]{36})/, async ({ request, env, match, viewer }) => {
    queryParams(request, []);
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Comment not found.");
    const result = await getCommentThread(env, match[1], viewer?.id ?? null);
    await attachTranslations(
      env,
      [result.comment, result.thread, ...result.thread.replies],
      requestLocale(request, viewer?.locale ?? null),
    );
    return json(result);
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
      const page = await listComments(env, entry.id, viewer?.id ?? null, input);
      const all: Comment[] = page.comments.flatMap((comment: Comment | CommentThread): Comment[] =>
        "replies" in comment ? [comment, ...comment.replies] : [comment],
      );
      await attachTranslations(env, all, requestLocale(request, viewer?.locale ?? null));
      return json(page);
    }
    queryParams(request, []);
    await attachEntryTranslations(env, [entry], requestLocale(request, viewer?.locale ?? null));
    return json({ entry });
  }),
  // POST /api/entries/:id/translation {locale, title, body, options} → {translation: {title, body, options} | null}
  write("POST", /entries\/([a-f0-9-]{36})\/translation/, async ({ request, env, match, viewer }) => {
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Topic or poll not found.");
    const { locale, ...shown } = await readJson(request, entryTranslationSchema);
    return json({ translation: await translateEntry(env, match[1], viewer.id, locale, Date.now(), shown) });
  }),
  // POST /api/comments/:id/translation {locale} → {translation: {text, mentions} | null}
  write("POST", /comments\/([a-f0-9-]{36})\/translation/, async ({ request, env, match, viewer }) => {
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Comment not found.");
    const { locale, text } = await readJson(request, translationSchema);
    return json({ translation: await translateComment(env, match[1], viewer.id, locale, Date.now(), text) });
  }),
  // An admin removal of someone else's comment passes the same step-up gate as the admin routes.
  write("POST", /comments/, async ({ request, app, env, viewer }) => {
    const input = await readJson(request, commentActionSchema);
    const result = await mutateComment(env, viewer.id, input, () => requireAdminSession(request, app));
    // An edited comment gets new translations after the response.
    if (input.action === "edit") translateAfterPost(env, "comment", input.id);
    return json(result);
  }),
];
