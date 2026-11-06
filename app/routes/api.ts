import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { apiRoutes, dispatch } from "../server/api";

// The endpoints live in app/server/api/*.ts as one handler table; see app/server/api/index.ts.

export async function loader({ request, context, params }: LoaderFunctionArgs): Promise<Response> {
  return dispatch(apiRoutes, request, context.get(appContext), params["*"] ?? "");
}

export async function action({ request, context, params }: ActionFunctionArgs): Promise<Response> {
  return dispatch(apiRoutes, request, context.get(appContext), params["*"] ?? "");
}
