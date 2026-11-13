import { listApplications, reviewApplication, submitApplication } from "../access.server";
import { consumeMutationQuota } from "../data.server";
import { json, readJson } from "../http.server";
import { notifyRoom } from "../live.server";
import { listReports, resolveReport, submitReport } from "../reports.server";
import { requireAdminSession } from "../stepup.server";
import {
  applicationQuerySchema,
  applicationReviewSchema,
  applicationSchema,
  reportQuerySchema,
  reportResolutionSchema,
  reportSchema,
} from "../validation";
import { get, parsedQuery, write, type ApiRoute } from "./router";

export const moderationRoutes: ApiRoute[] = [
  write("POST", /application/, async ({ request, env, viewer }) => {
    const input = await readJson(request, applicationSchema);
    await consumeMutationQuota(env, viewer.id);
    return json({ application: await submitApplication(env, viewer.id, input) });
  }),
  get(/admin\/applications/, async ({ request, app, env }) => {
    await requireAdminSession(request, app);
    return json(await listApplications(env, parsedQuery(request, ["status", "cursor"], applicationQuerySchema)));
  }),
  write("POST", /admin\/applications/, async ({ request, app, env }) => {
    const input = await readJson(request, applicationReviewSchema);
    const admin = await requireAdminSession(request, app);
    await consumeMutationQuota(env, admin.viewer.id);
    return json({ application: await reviewApplication(env, admin.viewer.id, input) });
  }),
  write("POST", /reports/, async ({ request, env, viewer }) =>
    json({ report: await submitReport(env, viewer.id, await readJson(request, reportSchema)) }),
  ),
  get(/admin\/reports/, async ({ request, app, env }) => {
    const admin = await requireAdminSession(request, app);
    return json(await listReports(env, admin.viewer.id, parsedQuery(request, ["status", "cursor"], reportQuerySchema)));
  }),
  write("POST", /admin\/reports/, async ({ request, app, env }) => {
    const input = await readJson(request, reportResolutionSchema);
    const admin = await requireAdminSession(request, app);
    await consumeMutationQuota(env, admin.viewer.id);
    const result = await resolveReport(env, admin.viewer.id, input, admin.stepUp);
    if (result.streamerId) notifyRoom(env, result.streamerId);
    return json({ status: result.status, resolved: result.resolved });
  }),
];
