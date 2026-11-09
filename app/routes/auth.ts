import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { createAuth } from "../server/auth.server";
import { errorResponse, readBody, requireSameOrigin } from "../server/http.server";

export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  try {
    return await createAuth(context.get(appContext).env).handler(request);
  } catch (error) {
    return errorResponse(error, request);
  }
}

export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  try {
    requireSameOrigin(request, context.get(appContext).env);
    const bytes = await readBody(request, 16 * 1024);
    return await createAuth(context.get(appContext).env).handler(
      new Request(request, { method: request.method, body: bytes }),
    );
  } catch (error) {
    return errorResponse(error, request);
  }
}
