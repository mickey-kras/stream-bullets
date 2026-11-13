import { redirect, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { requestViewer } from "../lib/shell.server";
import type { ConnectResult } from "../lib/activity";
import { completeConnect, platformSchema } from "../server/channels.server";
import { HttpError } from "../server/http.server";
import { withRouteErrors } from "../server/route-errors.server";

/**
 * `/channels/callback/:platform`: the provider sends the owner back here after a channel authorization. The
 * outcome goes to the fixed controls path as a short code; codes, tokens and states never appear in that URL.
 */
export const loader = withRouteErrors(async ({ request, params, context }: LoaderFunctionArgs) => {
  const app = context.get(appContext);
  const platform = platformSchema.safeParse(params.platform);
  if (!platform.success) throw new Response("Not found.", { status: 404 });
  const viewer = await requestViewer(request, app);
  let result: ConnectResult;
  try {
    result = await completeConnect(app.env, viewer?.id ?? null, platform.data, new URL(request.url).searchParams);
  } catch (error: unknown) {
    // A frozen or missing page, or a platform that is not configured.
    if (!(error instanceof HttpError)) throw error;
    result = "failed";
  }
  return redirect(`/overlay-control?channel=${platform.data}&result=${result}`, {
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
});
