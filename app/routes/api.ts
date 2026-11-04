import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { user } from "../../db/schema";
import { appContext, type AppContext, type AppEnv } from "../env";
import { configuredProviders, createAuth, getViewer } from "../server/auth.server";
import { deleteAccount, exportAccount, type AccountExport } from "../server/account.server";
import { notifyRoom } from "../server/live.server";
import {
  consumeMutationQuota,
  getEntry,
  getOwnStreamer,
  getStreamer,
  listComments,
  listEntries,
  listStreamers,
  mutateComment,
  mutateEntry,
  saveStreamer,
} from "../server/data.server";
import {
  commentActionSchema,
  commentQuerySchema,
  displayNameSchema,
  entryActionSchema,
  entryQuerySchema,
  streamerSchema,
  applicationQuerySchema,
  applicationReviewSchema,
  applicationSchema,
  accountDeletionSchema,
  reportQuerySchema,
  reportResolutionSchema,
  reportSchema,
} from "../server/validation";
import { listReports, resolveReport, submitReport } from "../server/reports.server";
import { HttpError, errorResponse, json, queryParams, readJson, requireSameOrigin } from "../server/http.server";
import { uploadImage } from "../server/images.server";
import {
  getStreamerAccess,
  listApplications,
  requireAdmin,
  reviewApplication,
  submitApplication,
} from "../server/access.server";

const accountSchema = z.object({ name: displayNameSchema }).strict();

function parsedQuery<T>(request: Request, keys: string[], schema: z.ZodType<T>): T {
  const result = schema.safeParse(Object.fromEntries(queryParams(request, keys)));
  if (!result.success) throw new HttpError(400, "Invalid query parameters.");
  return result.data;
}

function exportResponse(data: AccountExport): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="streambullets-data-${data.exportedAt.slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Ends the deleted account's browser session. Better Auth expires its cookies with their original attributes. */
async function endSession(request: Request, app: AppContext): Promise<void> {
  const { headers } = await createAuth(app.env).api.signOut({ headers: request.headers, returnHeaders: true });
  // Drop any refreshed session cookie that was queued while reading the viewer.
  app.responseHeaders.delete("Set-Cookie");
  for (const cookie of headers.getSetCookie()) app.responseHeaders.append("Set-Cookie", cookie);
}

async function entryResponse(
  request: Request,
  env: AppEnv,
  entryId: string,
  viewerId: string | null,
  comments: boolean,
): Promise<Response> {
  const current = await getEntry(env, entryId, viewerId);
  if (!current) throw new HttpError(404, "Topic or poll not found.");
  if (comments) {
    const input = parsedQuery(request, ["sort", "cursor"], commentQuerySchema);
    return json(await listComments(env, current.id, viewerId, input));
  }
  queryParams(request, []);
  return json({ entry: current });
}

export async function loader({ request, context, params }: LoaderFunctionArgs): Promise<Response> {
  try {
    const app = context.get(appContext);
    const path = params["*"] ?? "";
    const viewer = await getViewer(request, app);
    if (path === "me") {
      queryParams(request, []);
      return json({
        viewer,
        streamer: viewer ? await getOwnStreamer(app.env, viewer.id) : null,
        access: viewer ? await getStreamerAccess(app.env, viewer.id) : null,
        providers: configuredProviders(app.env),
      });
    }
    if (path === "account/export") {
      queryParams(request, []);
      if (request.headers.get("Sec-Fetch-Site") === "cross-site")
        throw new HttpError(403, "Use this site to download your data.");
      if (!viewer) throw new HttpError(401, "Sign in to continue.");
      await consumeMutationQuota(app.env, viewer.id, true);
      return exportResponse(await exportAccount(app.env, viewer.id));
    }
    if (path === "admin/applications") {
      if (!viewer) throw new HttpError(401, "Sign in to continue.");
      await requireAdmin(app.env, viewer.id);
      return json(await listApplications(app.env, parsedQuery(request, ["status", "cursor"], applicationQuerySchema)));
    }
    if (path === "admin/reports") {
      if (!viewer) throw new HttpError(401, "Sign in to continue.");
      return json(await listReports(app.env, viewer.id, parsedQuery(request, ["status", "cursor"], reportQuerySchema)));
    }
    if (path === "streamers") {
      const cursor = queryParams(request, ["cursor"]).get("cursor");
      return json(await listStreamers(app.env, cursor));
    }
    const board = /^streamers\/([a-z0-9_]{3,30})$/.exec(path);
    if (board) {
      const input = parsedQuery(request, ["kind", "sort", "query", "cursor"], entryQuerySchema);
      const streamer = await getStreamer(app.env, board[1]);
      if (!streamer) throw new HttpError(404, "Streamer not found.");
      return json(await listEntries(app.env, streamer, viewer?.id ?? null, input));
    }
    const entry = /^entries\/([a-f0-9-]{36})(\/comments)?$/.exec(path);
    if (entry && z.string().uuid().safeParse(entry[1]).success) {
      return await entryResponse(request, app.env, entry[1], viewer?.id ?? null, Boolean(entry[2]));
    }
    throw new HttpError(404, "Endpoint not found.");
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context, params }: ActionFunctionArgs): Promise<Response> {
  try {
    const app = context.get(appContext);
    requireSameOrigin(request, app.env);
    queryParams(request, []);
    const viewer = await getViewer(request, app);
    if (!viewer) throw new HttpError(401, "Sign in to continue.");
    const path = params["*"] ?? "";
    const upload = /^images\/(avatar|background)$/.exec(path);
    if (upload && request.method === "PUT") {
      await consumeMutationQuota(app.env, viewer.id, true);
      return json({ url: await uploadImage(request, app.env, viewer.id, upload[1]) });
    }
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
    if (path === "profile")
      return json({ streamer: await saveStreamer(app.env, viewer.id, await readJson(request, streamerSchema)) });
    if (path === "account") {
      const input = await readJson(request, accountSchema);
      await consumeMutationQuota(app.env, viewer.id);
      await drizzle(app.env.DB)
        .update(user)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(user.id, viewer.id));
      return json({ viewer: { ...viewer, name: input.name } });
    }
    if (path === "account/delete") {
      await readJson(request, accountDeletionSchema);
      await consumeMutationQuota(app.env, viewer.id);
      await deleteAccount(app.env, viewer.id);
      await endSession(request, app);
      return json({ deleted: true });
    }
    if (path === "application") {
      const input = await readJson(request, applicationSchema);
      await consumeMutationQuota(app.env, viewer.id);
      return json({ application: await submitApplication(app.env, viewer.id, input) });
    }
    if (path === "admin/applications") {
      const input = await readJson(request, applicationReviewSchema);
      await requireAdmin(app.env, viewer.id);
      await consumeMutationQuota(app.env, viewer.id);
      return json({ application: await reviewApplication(app.env, viewer.id, input) });
    }
    if (path === "reports")
      return json({ report: await submitReport(app.env, viewer.id, await readJson(request, reportSchema)) });
    if (path === "admin/reports") {
      const input = await readJson(request, reportResolutionSchema);
      await requireAdmin(app.env, viewer.id);
      await consumeMutationQuota(app.env, viewer.id);
      const result = await resolveReport(app.env, viewer.id, input);
      if (result.streamerId) await notifyRoom(app.env, result.streamerId);
      return json({ status: result.status, resolved: result.resolved });
    }
    if (path === "comments")
      return json(await mutateComment(app.env, viewer.id, await readJson(request, commentActionSchema)));
    const board = /^streamers\/([a-z0-9_]{3,30})$/.exec(path);
    if (board) {
      const input = await readJson(request, entryActionSchema);
      const streamer = await getStreamer(app.env, board[1]);
      if (!streamer) throw new HttpError(404, "Streamer not found.");
      const result = await mutateEntry(app.env, viewer.id, streamer.id, input);
      await notifyRoom(app.env, streamer.id);
      return json(result);
    }
    throw new HttpError(404, "Endpoint not found.");
  } catch (error) {
    return errorResponse(error);
  }
}
