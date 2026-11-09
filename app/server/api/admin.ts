import { consumeMutationQuota } from "../data.server";
import { json, queryParams, readJson } from "../http.server";
import { notifyRoom } from "../live.server";
import {
  isSensitivePageAction,
  listModerationPages,
  moderatePage,
  officialSchema,
  pageActionSchema,
  pageQuerySchema,
  removeEntryAsAdmin,
  entryRemovalSchema,
  entryStatusSchema,
  setEntryStatus,
  setOfficial,
} from "../moderation.server";
import { notifyOwner } from "../notify.server";
import {
  listReportGroups,
  listReportItems,
  reportBulkSchema,
  reportGroupQuerySchema,
  reportItemQuerySchema,
  resolveReports,
} from "../report-groups.server";
import {
  assertionSchema,
  getStepUpStatus,
  keyNameSchema,
  listKeys,
  registerKey,
  registrationOptions,
  registrationSchema,
  removeKey,
  renameKey,
  requireAdminSession,
  requireAdminViewer,
  stepUpOptions,
  verifyStepUp,
} from "../stepup.server";
import { get, parsedQuery, write, type ApiRoute } from "./router";

/**
 * Admin moderation and security keys (Phase 6). Every handler authorises on the server: the step-up endpoints
 * need an admin; everything else goes through requireAdminSession (admin + the ADMIN_STEP_UP policy).
 */

const ID = "([0-9a-f-]{36})";
const path = (pattern: string): RegExp => new RegExp(pattern, "u");

export const adminRoutes: ApiRoute[] = [
  get(/admin\/stepup/u, async ({ request, app }) => {
    queryParams(request, []);
    return json(await getStepUpStatus(request, app));
  }),
  write("POST", /admin\/stepup\/options/u, async ({ request, app }) => {
    const admin = await requireAdminViewer(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    return json(await stepUpOptions(app.env, admin));
  }),
  write("POST", /admin\/stepup\/verify/u, async ({ request, app }) => {
    const input = await readJson(request, assertionSchema);
    const admin = await requireAdminViewer(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    return json(await verifyStepUp(app.env, admin, input));
  }),
  get(/admin\/keys/u, async ({ request, app }) => {
    queryParams(request, []);
    const admin = await requireAdminSession(request, app);
    return json({ keys: await listKeys(app.env, admin.viewer.id) });
  }),
  write("POST", /admin\/keys\/options/u, async ({ request, app }) => {
    const admin = await requireAdminViewer(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    return json(await registrationOptions(app.env, admin));
  }),
  write("POST", /admin\/keys/u, async ({ request, app }) => {
    const input = await readJson(request, registrationSchema);
    const admin = await requireAdminViewer(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    return json({ key: await registerKey(app.env, admin, input) }, 201);
  }),
  write("PATCH", path(`admin/keys/${ID}`), async ({ request, app, match }) => {
    const input = await readJson(request, keyNameSchema);
    const admin = await requireAdminSession(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    await renameKey(app.env, admin, match[1], input.name);
    return json({ id: match[1], name: input.name });
  }),
  write("DELETE", path(`admin/keys/${ID}`), async ({ request, app, match }) => {
    const admin = await requireAdminViewer(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    await removeKey(app.env, admin, match[1]);
    return json({ removed: match[1] });
  }),
  get(/admin\/streamers/u, async ({ request, app }) => {
    const admin = await requireAdminSession(request, app);
    const query = parsedQuery(request, ["status", "query", "cursor"], pageQuerySchema);
    return json(await listModerationPages(app.env, admin.viewer.id, query));
  }),
  write("POST", path(`admin/streamers/${ID}`), async ({ request, app, match }) => {
    const input = await readJson(request, pageActionSchema);
    const admin = await requireAdminSession(request, app, { sensitive: isSensitivePageAction(input.action) });
    await consumeMutationQuota(app.env, admin.viewer.id);
    const page = await moderatePage(app.env, admin, match[1], input);
    await notifyRoom(app.env, page.id);
    const emailed: boolean = input.notify ? await notifyOwner(app.env, page.id, input.action) : false;
    return json({ page, emailed });
  }),
  write("POST", path(`admin/streamers/${ID}/official`), async ({ request, app, match }) => {
    const input = await readJson(request, officialSchema);
    // Who counts as StreamBullets itself is as sensitive as a suspension: it needs a fresh security-key check.
    const admin = await requireAdminSession(request, app, { sensitive: true });
    await consumeMutationQuota(app.env, admin.viewer.id);
    const page = await setOfficial(app.env, admin, match[1], input);
    await notifyRoom(app.env, page.id);
    return json({ page });
  }),
  get(/admin\/report-groups/u, async ({ request, app }) => {
    const admin = await requireAdminSession(request, app);
    const query = parsedQuery(request, ["status", "query", "cursor"], reportGroupQuerySchema.omit({ group: true }));
    return json(await listReportGroups(app.env, admin.viewer.id, { ...query, group: "streamer" }));
  }),
  get(path(`admin/report-groups/${ID}`), async ({ request, app, match }) => {
    const admin = await requireAdminSession(request, app);
    const query = parsedQuery(request, ["status", "cursor"], reportItemQuerySchema.omit({ streamer: true }));
    return json(await listReportItems(app.env, admin.viewer.id, { ...query, streamer: match[1] }));
  }),
  write("POST", /admin\/reports\/resolve/u, async ({ request, app }) => {
    const input = await readJson(request, reportBulkSchema);
    const admin = await requireAdminSession(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    const result = await resolveReports(app.env, admin, input);
    if (result.streamerId) await notifyRoom(app.env, result.streamerId);
    return json({ status: result.status, resolved: result.resolved });
  }),
  write("POST", path(`admin/entries/${ID}/remove`), async ({ request, app, match }) => {
    const input = await readJson(request, entryRemovalSchema);
    const admin = await requireAdminSession(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    const result = await removeEntryAsAdmin(app.env, admin, match[1], input);
    await notifyRoom(app.env, result.streamerId);
    return json({ removed: match[1], resolved: result.resolved });
  }),
  write("POST", path(`admin/entries/${ID}/status`), async ({ request, app, match }) => {
    const input = await readJson(request, entryStatusSchema);
    const admin = await requireAdminSession(request, app);
    await consumeMutationQuota(app.env, admin.viewer.id);
    const result = await setEntryStatus(app.env, admin, match[1], input);
    await notifyRoom(app.env, result.streamerId);
    return json({ id: match[1], status: result.status, statusReason: result.statusReason });
  }),
];
