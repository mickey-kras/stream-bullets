import { aiInterestSchema, aiInterestStatus, recordAiInterest } from "../ai.server";
import { json, queryParams, readJson } from "../http.server";
import { get, openWrite, type ApiRoute } from "./router";

// The AI interest counter on /ai: one unverified vote per visitor per day.
export const aiRoutes: ApiRoute[] = [
  // GET /api/ai-interest → {available, totals: {up, down}, mine}
  get(/ai-interest/, async ({ request, env }) => {
    queryParams(request, []);
    return json(await aiInterestStatus(env, request, Date.now()));
  }),
  // POST /api/ai-interest {vote: "up" | "down", agent?} → {counted, totals}. Signed out is fine.
  openWrite("POST", /ai-interest/, async ({ request, env }) => {
    const { vote } = await readJson(request, aiInterestSchema);
    return json(await recordAiInterest(env, request, vote, Date.now()));
  }),
];
