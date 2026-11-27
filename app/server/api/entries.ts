import { z } from "zod";
import {
  answerActionSchema,
  answerComment,
  answerLeadMinutes,
  answerLeadSchema,
  attachAnswerTranslations,
  translateAnswers,
  setAnswerLead,
} from "../comment-answers.server";
import {
  getCommentThread,
  listCommentRevisions,
  listComments,
  listReplies,
  mutateComment,
  type ReplyAnchor,
} from "../comments.server";
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

// A place in a thread: the time and ID of a reply, `<createdAt>.<id>`.
const replyCursor = z
  .string()
  .regex(/^\d{1,15}\.[0-9a-f-]{36}$/u)
  .transform((value: string): { createdAt: number; id: string } => {
    const dot: number = value.indexOf(".");
    return { createdAt: Number(value.slice(0, dot)), id: value.slice(dot + 1) };
  });

// One place at most: the page after a reply, before it, or from it on.
const replyQuerySchema = z
  .object({ after: replyCursor.optional(), before: replyCursor.optional(), from: replyCursor.optional() })
  .strict()
  .refine((value): boolean => [value.after, value.before, value.from].filter(Boolean).length <= 1, "Use one place.");

export const entryRoutes: ApiRoute[] = [
  get(/comments\/([a-f0-9-]{36})/, async ({ request, env, match, viewer }) => {
    queryParams(request, []);
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Comment not found.");
    const result = await getCommentThread(env, match[1], viewer?.id ?? null);
    const comments: Comment[] = [result.comment, result.thread, ...result.thread.replies];
    const locale = requestLocale(request, viewer?.locale ?? null);
    await attachTranslations(env, comments, locale, viewer?.keepOriginal ?? []);
    await attachAnswerTranslations(env, comments, locale, viewer?.keepOriginal ?? []);
    return json(result);
  }),
  // GET /api/comments/:id/replies?after= | before= | from=<createdAt>.<replyId> → {replies, earlierReplies}: up to 50
  // replies of the thread of root comment `:id` at that place, oldest first; the first 50 without one.
  get(/comments\/([a-f0-9-]{36})\/replies/, async ({ request, env, match, viewer }) => {
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Comment not found.");
    const query = parsedQuery(request, ["after", "before", "from"], replyQuerySchema);
    const direction = (["after", "before", "from"] as const).find((key) => query[key] !== undefined);
    const anchor: ReplyAnchor | null = direction ? { direction, ...query[direction]! } : null;
    const page = await listReplies(env, match[1], viewer?.id ?? null, anchor);
    const locale = requestLocale(request, viewer?.locale ?? null);
    await attachTranslations(env, page.replies, locale, viewer?.keepOriginal ?? []);
    await attachAnswerTranslations(env, page.replies, locale, viewer?.keepOriginal ?? []);
    return json(page);
  }),
  // GET /api/comments/:id/history → {revisions: [{text, mentions, writtenAt, editedAt}]}, oldest first. The page
  // owner and admins (with step-up) only; 404 for everyone else, also when signed out.
  get(/comments\/([a-f0-9-]{36})\/history/, async ({ request, app, env, match, viewer }) => {
    queryParams(request, []);
    if (!viewer || !z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Comment not found.");
    const revisions = await listCommentRevisions(env, viewer.id, match[1], () => requireAdminSession(request, app));
    return json({ revisions });
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
      const locale = requestLocale(request, viewer?.locale ?? null);
      await attachTranslations(env, all, locale, viewer?.keepOriginal ?? []);
      await attachAnswerTranslations(env, all, locale, viewer?.keepOriginal ?? []);
      return json(page);
    }
    queryParams(request, []);
    await attachEntryTranslations(
      env,
      [entry],
      requestLocale(request, viewer?.locale ?? null),
      viewer?.keepOriginal ?? [],
    );
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
  // POST /api/comments/:id/answer {action: "mark" | "unmark"} | {action: "offset", offsetSeconds} → {answer | null}.
  // The owner of the page of the comment only; 404 for everyone else.
  write("POST", /comments\/([a-f0-9-]{36})\/answer/, async ({ request, env, match, viewer }) => {
    if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Comment not found.");
    const answer = await answerComment(env, viewer.id, match[1], await readJson(request, answerActionSchema));
    await translateAnswers(env, [answer], requestLocale(request, viewer.locale), viewer.keepOriginal);
    return json({ answer });
  }),
  // GET and PUT /api/streamer/answer-lead {leadMinutes}: the time code of a new mark is this far back. The viewer's
  // own page only.
  get(/streamer\/answer-lead/, async ({ request, env, viewer }) => {
    queryParams(request, []);
    return json({ leadMinutes: await answerLeadMinutes(env, requireViewer(viewer).id) });
  }),
  write("PUT", /streamer\/answer-lead/, async ({ request, env, viewer }) =>
    json(await setAnswerLead(env, viewer.id, await readJson(request, answerLeadSchema))),
  ),
  // An admin removal of someone else's comment passes the same step-up gate as the admin routes.
  write("POST", /comments/, async ({ request, app, env, viewer }) => {
    const input = await readJson(request, commentActionSchema);
    const result = await mutateComment(env, viewer.id, input, () => requireAdminSession(request, app));
    // An edited comment gets new translations after the response.
    if (input.action === "edit") translateAfterPost(env, "comment", input.id);
    return json(result);
  }),
];
