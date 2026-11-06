import { listApplications, requireAdmin, reviewApplication, submitApplication } from "../access.server";
import { consumeMutationQuota } from "../data.server";
import { json, readJson } from "../http.server";
import { notifyRoom } from "../live.server";
import { listReports, resolveReport, submitReport } from "../reports.server";
import {
  applicationQuerySchema,
  applicationReviewSchema,
  applicationSchema,
  reportQuerySchema,
  reportResolutionSchema,
  reportSchema,
} from "../validation";
import { get, parsedQuery, requireViewer, write, type ApiRoute } from "./router";

/** The streamer waitlist and content reports, for applicants, reporters and admins. */
export const moderationRoutes: ApiRoute[] = [
  write("POST", /application/, async ({ request, env, viewer }) => {
    const input = await readJson(request, applicationSchema);
    await consumeMutationQuota(env, viewer.id);
    return json({ application: await submitApplication(env, viewer.id, input) });
  }),
  get(/admin\/applications/, async ({ request, env, viewer }) => {
    const admin = requireViewer(viewer);
    await requireAdmin(env, admin.id);
    return json(await listApplications(env, parsedQuery(request, ["status", "cursor"], applicationQuerySchema)));
  }),
  write("POST", /admin\/applications/, async ({ request, env, viewer }) => {
    const input = await readJson(request, applicationReviewSchema);
    await requireAdmin(env, viewer.id);
    await consumeMutationQuota(env, viewer.id);
    return json({ application: await reviewApplication(env, viewer.id, input) });
  }),
  write("POST", /reports/, async ({ request, env, viewer }) =>
    json({ report: await submitReport(env, viewer.id, await readJson(request, reportSchema)) }),
  ),
  get(/admin\/reports/, async ({ request, env, viewer }) => {
    const admin = requireViewer(viewer);
    return json(await listReports(env, admin.id, parsedQuery(request, ["status", "cursor"], reportQuerySchema)));
  }),
  write("POST", /admin\/reports/, async ({ request, env, viewer }) => {
    const input = await readJson(request, reportResolutionSchema);
    await requireAdmin(env, viewer.id);
    await consumeMutationQuota(env, viewer.id);
    const result = await resolveReport(env, viewer.id, input);
    if (result.streamerId) await notifyRoom(env, result.streamerId);
    return json({ status: result.status, resolved: result.resolved });
  }),
];
